require("dotenv").config();
const { MovieDb } = require("moviedb-promise");
const Utils = require("../utils/parseProps");
const moviedb = new MovieDb(process.env.TMDB_API);
const tvdb = require("./tvdb");
const { getLogo } = require("./getLogo");
const { getImdbRating } = require("./getImdbRating");
const { to3LetterCode } = require('./language-map');

const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com';

const processLogo = (logoUrl) => {
  if (!logoUrl) return null;
  return logoUrl.replace(/^http:/, "https:");
};
const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// --- Main Orchestrator ---
async function getMeta(type, language, stremioId, config = {}, catalogChoices) {
  try {
    let meta;
    if (type === 'movie') {
      meta = await getMovieMeta(stremioId, language, config, catalogChoices);
    } else { 
      meta = await getSeriesMeta(stremioId, language, config, catalogChoices);
    }
    return { meta };
  } catch (error) {
    console.error(`Failed to get meta for ${type} with ID ${stremioId}:`, error.message);
    return { meta: null };
  }
}

// --- Movie Worker ---
async function getMovieMeta(stremioId, language, config, catalogChoices) {
  let tmdbId = stremioId.replace('tmdb:', '');
  if (stremioId.startsWith('tt')) {
    const findResults = await moviedb.find({ id: stremioId, external_source: 'imdb_id' });
    const movieTmdb = findResults.movie_results?.[0];
    if (!movieTmdb) throw new Error(`Movie with IMDb ID ${stremioId} not found on TMDB.`);
    tmdbId = movieTmdb.id;
  }
  const movieData = await moviedb.movieInfo({ id: tmdbId, language, append_to_response: "videos,credits,external_ids" });
  return buildMovieResponse(movieData, language, config, catalogChoices);
}

// --- Series Worker (TVDB Version) ---
async function getSeriesMeta(stremioId, language, config, catalogChoices) {
  let tvdbId;
  if (stremioId.startsWith('tvdb:')) {
    tvdbId = stremioId.split(':')[1];
  } else {
    
    const tmdbIdToFind = stremioId.startsWith('tmdb:') ? stremioId.split(':')[1] : (await moviedb.find({ id: stremioId, external_source: 'imdb_id' })).tv_results[0]?.id;
    if (!tmdbIdToFind) throw new Error(`Could not resolve ${stremioId} to a TMDB ID.`);
    
    const tmdbInfo = await moviedb.tvInfo({ id: tmdbIdToFind, append_to_response: 'external_ids' });
    tvdbId = tmdbInfo.external_ids?.tvdb_id;
  }

  if (!tvdbId) {
    throw new Error(`Could not resolve ${stremioId} to a TVDB ID.`);
  }

  
  const [baseData, episodesData] = await Promise.all([
    tvdb.getSeriesExtended(tvdbId),
    tvdb.getSeriesEpisodes(tvdbId, language)
  ]);

  if (!baseData || !episodesData) {
    throw new Error(`Could not fetch complete data for TVDB ID ${tvdbId}.`);
  }

  return buildSeriesResponseFromTvdb(baseData, episodesData, language, config, catalogChoices);
}


// --- BUILDERS ---

async function buildMovieResponse(movieData, language, config, catalogChoices) {
  const { id: tmdbId, title, external_ids, poster_path, credits } = movieData;
  const imdbId = external_ids?.imdb_id;
  const castCount = config.castCount === 'unlimited' ? undefined : ([5, 10, 15].includes(config.castCount) ? config.castCount : 5);
  const [logoUrl, imdbRatingValue] = await Promise.all([
    getLogo('movie', { tmdbId }, language, movieData.original_language),
    getImdbRating(imdbId, 'movie')
  ]);
  const imdbRating = imdbRatingValue || movieData.vote_average?.toFixed(1) || "N/A";
  const fallbackPosterUrl = `https://image.tmdb.org/t/p/w500${poster_path}`;
  const posterProxyUrl = `${host}/poster/movie/tmdb:${movieData.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.rpdbkey}`;
  //console.log(Utils.parseCast(credits, castCount));
  return {
    id: `tmdb:${tmdbId}`,
    type: 'movie',
    name: title,
    imdb_id: imdbId,
    slug: Utils.parseSlug('movie', title, imdbId),
    genres: Utils.parseGenres(movieData.genres),
    description: movieData.overview,
    director: Utils.parseDirector(credits).join(', '),
    writer: Utils.parseWriter(credits).join(', '),
    year: movieData.release_date ? movieData.release_date.substring(0, 4) : "",
    released: new Date(movieData.release_date),
    runtime: Utils.parseRunTime(movieData.runtime),
    country: Utils.parseCoutry(movieData.production_countries),
    imdbRating,
    poster: config.rpdbkey ? posterProxyUrl : fallbackPosterUrl,
    background: `https://image.tmdb.org/t/p/original${movieData.backdrop_path}`,
    logo: processLogo(logoUrl),
    trailers: Utils.parseTrailers(movieData.videos),
    trailerStreams: Utils.parseTrailerStream(movieData.videos),
    links: Utils.buildLinks(imdbRating, imdbId, title, 'movie', movieData.genres, credits, language, castCount, catalogChoices),
    behaviorHints: { defaultVideoId: imdbId || `tmdb:${tmdbId}`, hasScheduledVideos: false },
    app_extras: { cast: Utils.parseCast(credits, castCount) }
  };
}

async function buildSeriesResponseFromTvdb(tvdbShow, tvdbEpisodes, language, config, catalogChoices) {
  const { year, image: tvdbPosterPath, remoteIds, characters, episodes } = tvdbShow;
  const langCode = language.split('-')[0];
  const langCode3 = await to3LetterCode(langCode);
  const nameTranslations = tvdbShow.translations?.nameTranslations || [];
  const overviewTranslations = tvdbShow.translations?.overviewTranslations || [];
  const translatedName = nameTranslations.find(t => t.language === langCode3)?.name
             || nameTranslations.find(t => t.language === 'eng')?.name
             || tvdbShow.name;
             
  const overview = overviewTranslations.find(t => t.language === langCode3)?.overview
                   || overviewTranslations.find(t => t.language === 'eng')?.overview
                   || tvdbShow.overview;
  const imdbId = remoteIds?.find(id => id.sourceName === 'IMDB')?.id;
  const tmdbId = remoteIds?.find(id => id.sourceName === 'TheMovieDB')?.id;
  const tvdbId = tvdbShow.id;
  const castCount = config.castCount === 'unlimited' ? undefined : ([5, 10, 15].includes(config.castCount) ? config.castCount : 5);

  const [logoUrl, imdbRatingValue] = await Promise.all([
    getLogo('series', { tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString() }, language, tvdbShow.originalLanguage),
    getImdbRating(imdbId, 'series')
  ]);
  const imdbRating = imdbRatingValue || (tvdbShow.score > 0 ? tvdbShow.score.toFixed(1) : "N/A");

  const fallbackPosterUrl = tvdbPosterPath ? `${tvdbPosterPath}` : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
  const posterProxyUrl = `${host}/poster/series/tvdb:${tvdbShow.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.rpdbkey}`;
  const tmdbLikeCredits = {
    cast: (characters || []).map(c => ({
      name: c.personName,
      character: c.name,
      profile_path: c.image 
    })),
    crew: []
  };

  const videos = (tvdbEpisodes.episodes || [])
    .map(episode => {
        const thumbnailUrl = episode.image ? `${TVDB_IMAGE_BASE}${episode.image}` : null;
        const finalThumbnail = config.hideEpisodeThumbnails && thumbnailUrl
            ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
            : thumbnailUrl;

        return {
            id: `${imdbId || `tvdb${tvdbId}`}:${episode.seasonNumber}:${episode.number}`,
            title: episode.name || `Episode ${episode.number}`,
            season: episode.seasonNumber,
            episode: episode.number,
            thumbnail: finalThumbnail, 
            overview: episode.overview,
            released: episode.aired ? new Date(episode.aired) : null,
            available: episode.aired ? new Date(episode.aired) < new Date() : false,
        };
    });
  //console.log(tvdbShow.artworks?.find(a => a.type === 2)?.image);
  const meta = {
    id: tmdbId ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}`,
    type: 'series',
    name: translatedName,
    imdb_id: imdbId,
    slug: Utils.parseSlug('series', translatedName, imdbId),
    genres: tvdbShow.genres?.map(g => g.name) || [],
    description: overview,
    writer: (tvdbShow.companies?.production || []).map(p => p.name).join(', '),
    year: year,
    released: new Date(tvdbShow.firstAired),
    runtime: Utils.parseRunTime(tvdbShow.averageRuntime),
    status: tvdbShow.status?.name,
    country: tvdbShow.originalCountry,
    imdbRating,
    poster: config.rpdbkey ? posterProxyUrl : fallbackPosterUrl,
    background: tvdbShow.artworks?.find(a => a.type === 3)?.image, 
    logo: processLogo(logoUrl),
    videos: videos,
    links: Utils.buildLinks(imdbRating, imdbId, translatedName, 'series', tvdbShow.genres, tmdbLikeCredits, language, castCount, catalogChoices),
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: true },
    app_extras: { cast: Utils.parseCast(tmdbLikeCredits, castCount) }
  };
  //console.log(Utils.parseCast(tmdbLikeCredits, castCount));
  return meta;
}

module.exports = { getMeta };
