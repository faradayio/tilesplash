var fs = require('fs');
var express = require('express');
var async = require('async');
var topojson = require('topojson');
var pg = require('pg');
var SphericalMercator = require('sphericalmercator');
var Caching = require('caching');
var clone = require('clone');
var connectTimeout = require('connect-timeout');
var mapnik = require('mapnik');
var path = require('path');

mapnik.register_datasource(path.join(mapnik.settings.paths.input_plugins, 'geojson.input'));

function setStatementTimeout(client) {
  return new Promise(function(resolve, reject){
    var statementTimeout = parseInt(process.env.TILESPLASH_STATEMENT_TIMEOUT) || 0;
    if (statementTimeout && statementTimeout > 0) {
      client.query('SET statement_timeout='+statementTimeout, [], function(err){
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

// allowing tho options object for addGeoJson() - simplification settings, etc.
function stringifyProtobuf(layers, tile, mvtOptions) {
  var vtile = new mapnik.VectorTile(tile.z, tile.x, tile.y);
  for (var layerName in layers) {
    vtile.addGeoJSON(JSON.stringify(layers[layerName]), layerName, mvtOptions);
  }
  return vtile.getData();
}

var pgMiddleware = function(_dbOptions){
  var dbOptions;
  if (typeof _dbOptions === 'string') {
    dbOptions = _dbOptions;
  } else {
    dbOptions = {};
    Object.keys(_dbOptions).forEach(function(key){
      dbOptions[key] = _dbOptions[key];
    });
    dbOptions.poolSize = dbOptions.poolSize || 64;
  }

  return function(req, res, next){
    req.db = {};
    req.db.query = function(sql, bindvars, callback){
      if (typeof bindvars === 'function') {
        callback = bindvars;
        bindvars = undefined;
      }

      var poolTimedOut = false;
      var poolTimeout = setTimeout(function(){
        poolTimedOut = true;
        callback(new Error('failed to get db connection'));
      }, 5000);

      pg.connect(dbOptions, function(err, client, done){
        if (poolTimedOut) {
          done();
          return;
        }

        clearTimeout(poolTimeout);
        if (err) {
          callback(err);
          done();
          return;
        }

        res.on('finish', done);
        res.on('error', done);
        req.on('timeout', done);

        setStatementTimeout(client).then(function(){
          client.query(sql, bindvars, function(err, result){
            callback(err, result);
            done();
          });
        }).catch(function(err){
          callback(err);
          done();
        });
      });
    };

    next();
  };
};

/*
Tilesplash
@constructor

- dbOptions : options passed to the postgres database, required
- cacheType : how to cache tiles, defaults to 'memory', optional
- cacheOptions : options to pass to the caching library <https://www.npmjs.com/package/caching>, optional
- instrument : probes to instrument various parts of the query cycle, optional. Instrumentation points:
  - parseSql: time it takes to parse sql templates into sql strings
  - toGeoJson: the time it takes to run the sql and translate it to geojson
  - runQuery: the time it takes to run a query  (I think)
  - gotTile: the round-trip time to get a tile (I think)
 */
var Tilesplash = function(dbOptions, cacheType, cacheOptions, instrument){
  this.projection = new SphericalMercator({
    size: 256
  });

  this.dbOptions = dbOptions;
  this.dbCacheKey = JSON.stringify(dbOptions);

  this.server = express();
  this.instrument = instrument || {};
  var timeout = parseInt(process.env.TILESPLASH_REQUEST_TIMEOUT) || 0;

  if (timeout) {
    this.server.use(connectTimeout(timeout));
  }

  var self = this;
  this.server.use(function(req, res, next){
    req.on('timeout', function(){
      self.log('Request timed out', 'error');
    });
    next();
  });

  this.server.use(pgMiddleware(dbOptions));

  this.cacheOptions = cacheOptions || {};
  this._cache = new Caching(cacheType || 'memory', cacheOptions);

  this.logLevel('info');
};

Tilesplash.prototype.logging = function(callback){
  this.log = callback;
};

Tilesplash.prototype.logLevel = function(logLevel){
  var logLevels = ['debug', 'info', 'warn', 'error'];
  logLevel = logLevels.indexOf(logLevel);

  this.logging(function(message, level){
    var messageLevel = logLevels.indexOf(level);
    if (logLevel <= messageLevel) {
      console.log('['+level+']', JSON.stringify(message, null, 2));
    }
  });
};

Tilesplash.prototype.defaultCacheKeyGenerator = function(tile){
  return 'tilesplash_tile:'+this.dbCacheKey+'/'+tile.layer+'/'+tile.z+'/'+tile.x+'/'+tile.y;
};

Tilesplash.prototype.cache = function(cacheKeyGenerator, ttl){
  var self = this;
  if (typeof cacheKeyGenerator === 'number') {
    ttl = cacheKeyGenerator;
    cacheKeyGenerator = undefined;
  }
  this.defaultCacher = cacheKeyGenerator || function(tile){
    return self.defaultCacheKeyGenerator(tile);
  };
  this.defaultTtl = ttl;
};

function stringifyTopojson(layers){
  layers = clone(layers);
  return topojson.topology(layers, {
    'property-transform': function(properties, key, value){
      properties[key] = value;
      return true;
    }
  });
}

Tilesplash.prototype.layer = function(name){
  var callbacks = Array.prototype.slice.call(arguments);
  callbacks.shift();

  // pop off renderer for future use
  var tileRenderer = callbacks.pop();

  var mvtOptions = {};
  // if the last argument is an object, use it as mvtOptions
  if (typeof callbacks[callbacks.length - 1] === 'object') {
    mvtOptions = callbacks.pop()
  }

  var self = this;

  // actual route creation
  this.server.get('/'+name+'/:z/:x/:y.:ext', function(req, res, throwError){
    var render = function(){
      render.query.apply(render, arguments);
    };
    render.query = function(data){
      gotTile(data);
    };
    render.queryFile = function(file, encoding){
      fs.readFile(file, encoding || 'utf8', function(err, data){
        if (err) {
          render.error(err);
        } else {
          gotTile(data);
        }
      });
    };
    render.raw = function(){
      res.send.apply(res, arguments);
    };
    render.rawFile = function(file, encoding){
      fs.readFile(file, encoding || 'utf8', function(err, data){
        if (err) {
          render.error(err);
        } else {
          render.raw(data);
        }
      });
    };

    render.error = function(msg){
      render.raw(500);
      throwError( (msg instanceof Error) ? msg : new Error(msg) );
    };

    if (req.params.ext != 'topojson' && req.params.ext != 'mvt') {
      render.error('unsupported extension '+req.params.ext);
      return;
    }

    var stringify = (req.params.ext == 'topojson') ? stringifyTopojson : stringifyProtobuf;

    var tile = {};
    tile.layer = name;
    tile.x = req.params.x*1;
    tile.y = req.params.y*1;
    tile.z = req.params.z*1;

    render.empty = function(){
      render.raw(stringify([], tile, {}));
    };

    tile.bounds = self.projection.bbox(req.params.x, req.params.y, req.params.z, false, '900913');
    tile.bbox = [
      'ST_SetSRID(',
        'ST_MakeBox2D(',
          'ST_MakePoint(', tile.bounds[0], ', ', tile.bounds[1], '), ',
          'ST_MakePoint(', tile.bounds[2], ', ', tile.bounds[3], ')',
        '), ',
        '3857',
      ')'
    ].join('');
    tile.bbox_4326 = 'ST_Transform('+tile.bbox+', 4326)';
    tile.geom_hash = 'Substr(MD5(ST_AsBinary(the_geom)), 1, 10)';

    self.log('Rendering tile '+tile.layer+'/'+tile.z+'/'+tile.x+'/'+tile.y, 'debug');

    function startTrace() {
      var start = process.hrtime();
      return function endTrace() {
        var diff = process.hrtime(start);

        return (diff[0] * 1e9 + diff[1])/1e6;
      };
    }


    var parseSql = function(sql, done){
      var trace = startTrace(),
          instrument = self.instrument.parseSql || function() {};

      if (typeof sql === 'number') {
        instrument(trace());
        done(null, sql);
        return;
      }
      if (typeof sql === 'object') {
        if (Array.isArray(sql)) {
          async.map(sql, function(item, next){
            parseSql(item, function(err, out){
              next(err, out);
            });
          }, function(err, results){
            instrument(trace());
            done(err, results);
          });
          return;
        } else {
          var keys = Object.keys(sql);
          async.map(keys, function(item, next){
            parseSql(sql[item], function(err, out){
              next(err, out);
            });
          }, function(err, results){
            var output = {};
            keys.forEach(function(d, i){
              output[d] = results[i];
            });

            instrument(trace());
            done(err, output);
          });
          return;
        }
      }
      if (typeof sql !== 'string') {
        done(['Trying to parse non-string SQL', sql]);
        return;
      }
      var templatePattern = /!([0-9a-zA-Z_\-]+)!/g;

      sql = sql.replace(templatePattern, function(match){
        match = match.substr(1, match.length-2);
        return tile[match];
      });
      done(null, sql);
    };

    var sqlToGeojson = function(sql, done){
      var instrument = self.instrument.toGeoJson || function() {},
          trace = startTrace();

      if (sql === false || sql === null) {
        instrument(trace());
        done(null, {});
        return;
      }
      parseSql(sql, function(parsingError, fullsql){
        if (parsingError) {
          instrument(trace());
          done(parsingError);
          return;
        }
        var args = [];
        if (typeof fullsql === 'object' && Array.isArray(fullsql)) {
          args = fullsql;
          fullsql = args.shift();
        }
        self.log('Running Query', 'debug');
        self.log('  SQL: '+fullsql, 'debug');
        self.log('  Arguments: '+JSON.stringify(args), 'debug');


        req.db.query(fullsql, args, function(sqlError, result){
          if (sqlError) {
            instrument(trace());
            done([sqlError, fullsql, args]);
          } else {
            var geojson = {
              "type": "FeatureCollection",
              "features": []
            };
            result.rows.forEach(function(row){
              var properties = {};
              for (var attribute in row) {
                if (attribute !== 'the_geom_geojson') {
                  properties[attribute] = row[attribute];
                }
              }
              geojson.features.push({
                "type": "Feature",
                "geometry": JSON.parse(row.the_geom_geojson),
                "properties": properties
              });
            });

            instrument(trace());
            done(null, geojson);
          }
        });
      });
    };

    var tileContext = {
      cache: function(cacheKeyGenerator, ttl){
        if (typeof cacheKeyGenerator === 'number') {
          ttl = cacheKeyGenerator;
          cacheKeyGenerator = undefined;
        }
        if (typeof cacheKeyGenerator === 'function') {
          this._cacher = cacheKeyGenerator;
        }
        this._ttl = ttl;
      }
    };

    var runQuery = function(structuredSql, done){
      var instrument = self.instrument.runQuery || function() {},
          trace = startTrace();

      if (structuredSql === false || structuredSql === null) {
        instrument(trace());
        done(null, {});
        return;
      }

      if (typeof structuredSql !== 'object' || Array.isArray(structuredSql)) {
        structuredSql = {vectile: structuredSql};
      }

      var geojsonLayers = {};
      async.forEach(Object.keys(structuredSql), function(layer, next){
        sqlToGeojson(structuredSql[layer], function(err, geojson){
          if (err) {
            next(err);
          } else {
            geojsonLayers[layer] = geojson;
            next();
          }
        });
      }, function(err){
        instrument(trace());
        if (err) {
          done(err);
        } else {
          done(null, geojsonLayers);
        }
      });
    };

    var gotTile = function(tileOutput){
      var instrument = self.instrument.gotTile || function() {},
          trace = startTrace();

      parseSql(tileOutput, function(parsingError, structuredSql){
        if (parsingError) {
          instrument(trace());
          render.error(['SQL Parsing Error', parsingError]);
          return;
        }
        var cacher = tileContext._cacher || self.defaultCacher || false;

        if (cacher) {
          var cacheKey = cacher(tile);
          var ttl;
          if (typeof tileContext._ttl === 'number') {
            ttl = tileContext._ttl;
          } else if (typeof self.defaultTtl === 'number') {
            ttl = self.defaultTtl;
          } else {
            ttl = 0;
          }
          self._cache(cacheKey, ttl, function(done){
            instrument(trace());
            self.log('cache miss', 'debug');
            runQuery(structuredSql, function(queryError, layers){
              done(queryError, layers);
            });
          }, function(layerError, layers){
            instrument(trace());
            if (layerError) {
              render.error(['layer error', layerError]);
            } else {
              res.send(stringify(layers, tile, mvtOptions));
            }
          });
        } else {
          runQuery(structuredSql, function(queryError, layers){
            instrument(trace());
            if (queryError) {
              render.error(['error running query', queryError]);
            } else {
              res.send(stringify(layers, tile, mvtOptions));
            }
          });
        }
      });
    };

    async.eachSeries(callbacks, function(middleware, next){
      middleware(req, res, tile, function(err){
        next(err);
      });
    }, function(err){
      if (err) {
        render.error(['Middleware error', err]);
      } else {
        tileRenderer.call(tileContext, tile, render);
      }
    });
  });
};

module.exports = Tilesplash;
