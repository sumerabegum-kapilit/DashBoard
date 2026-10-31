// Data studio module: data modeling, relationships and dashboards over data the host application provides.
// See README.md for the integration guide.
const { createStudio } = require('./server/service');
const { createRouter, studioAssets, CLIENT } = require('./server/http');
const { memoryProvider, typeOf } = require('./server/input');
const { postgresProvider, introspectPostgres } = require('./server/providers/postgres');
const { sqliteProvider, sqliteFunctions } = require('./server/providers/sqlite');
const { memoryStore, jsonFileStore } = require('./server/stores');

module.exports = {
  // the service and its HTTP face
  createStudio, createRouter, studioAssets, clientDir: CLIENT,
  // data providers: rows in memory, or SQL run through the host's own query function
  memoryProvider, postgresProvider, sqliteProvider, sqliteFunctions, introspectPostgres, typeOf,
  // where configuration is kept
  memoryStore, jsonFileStore,
};
