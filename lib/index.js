var fs = require('fs');
var express = require('express');
var async = require('async');
var topojson = require('topojson');
var pg = require('pg');
var SphericalMercator = require('sphericalmercator');
var Caching = require('caching');

var pgMiddleware = function(dbOptions){
  return function(req, res, next){
    pg.connect(dbOptions, function(err, client, done){
      if (err) {
        console.error('Failed to connect to db', err);
        res.send(500);
      } else {
        req.db = client;
        res.on('finish', done);
        res.on('error', done);
        next();
      }
    });
  };
};

var Tilesplash = function(dbOptions, cacheType){
  this.projection = new SphericalMercator({
    size: 256
  });

  this.dbOptions = dbOptions;
  this.dbCacheKey = JSON.stringify(dbOptions);

  this.server = express();
  this.server.use(pgMiddleware(dbOptions));

  this._cache = new Caching(cacheType || 'memory');

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
      console.log('['+level+']', message);
    }
  });
};

Tilesplash.prototype.defaultCacheKeyGenerator = function(tile){
  return 'tilesplash_tile:'+this.dbCacheKey+'/'+tile.layer+'/'+tile.z+'/'+tile.x+'/'+tile.y;
};

Tilesplash.prototype.cache = function(cacheKeyGenerator, ttl){
  var self = this;
  if (typeof cacheKeyGenerator == 'number') {
    ttl = cacheKeyGenerator;
    cacheKeyGenerator = undefined;
  }
  this.defaultCacher = cacheKeyGenerator || function(tile){
    return self.defaultCacheKeyGenerator(tile);
  };
  this.defaultTtl = ttl;
};

Tilesplash.prototype.layer = function(name, ___){
  var callbacks = Array.prototype.slice.call(arguments);
  callbacks.shift();
  var tileRenderer = callbacks.pop();

  var self = this;
  this.server.get('/'+name+'/:z/:x/:y.topojson', function(req, res){
    var tile = {};
    tile.layer = name;
    tile.x = req.params.x*1;
    tile.y = req.params.y*1;
    tile.z = req.params.z*1;

    tile.bounds = self.projection.bbox(req.params.x, req.params.y, req.params.z, false, '900913');
    tile.bbox = 'ST_SetSRID(ST_MakeBox2D(ST_MakePoint('+tile.bounds[0]+', '+tile.bounds[1]+'), ST_MakePoint('+tile.bounds[2]+', '+tile.bounds[3]+')), 3857)';
    tile.bbox_4326 = 'ST_Transform('+tile.bbox+', 4326)';
    tile.geom_hash = 'Substr(MD5(ST_AsBinary(the_geom)), 1, 10)';

    self.log('Rendering tile '+tile.layer+'/'+tile.z+'/'+tile.x+'/'+tile.y, 'debug');

    var parseSql = function(sql, done){
      if (typeof sql == 'number') {
        done(null, sql);
        return;
      }
      if (typeof sql == 'object') {
        if (Array.isArray(sql)) {
          async.map(sql, function(item, next){
            parseSql(item, function(err, out){
              next(err, out);
            });
          }, function(err, results){
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
            done(err, output);
          });
          return;
        }
      }
      if (typeof sql != 'string') {
        done(['Trying to parse non-string SQL', sql]);
        return;
      }
      var templatePattern = /\!([a-zA-Z_\-]+)\!/g;
      var templateVariables = {};

      sql = sql.replace(templatePattern, function(match){
        match = match.substr(1, match.length-2);
        return tile[match];
      });
      done(null, sql);
    };

    var sqlToGeojson = function(sql, done){
      if (sql === false || sql === null) {
        done(null, {});
        return;
      }
      parseSql(sql, function(parsingError, fullsql){
        if (parsingError) {
          done(parsingError);
          return;
        }
        var args = [];
        if (typeof fullsql == 'object' && Array.isArray(fullsql)) {
          args = fullsql;
          fullsql = args.shift();
        }
        self.log('Running Query', 'debug');
        self.log('  SQL: '+fullsql, 'debug');
        self.log('  Arguments: '+JSON.stringify(args), 'debug');
        req.db.query(fullsql, args, function(sqlError, result){
          if (sqlError) {
            done([sqlError, fullsql, args]);
          } else {
            var geojson = {
              "type": "FeatureCollection",
              "features": []
            };
            result.rows.forEach(function(row){
              var properties = {};
              for (var attribute in row) {
                if (attribute != 'the_geom_geojson') {
                  properties[attribute] = row[attribute];
                }
              }
              geojson.features.push({
                "type": "Feature",
                "geometry": JSON.parse(row.the_geom_geojson),
                "properties": properties
              });
            });

            done(null, geojson);
          }
        });
      });
    };

    var tileContext = {
      cache: function(cacheKeyGenerator, ttl){
        if (typeof cacheKeyGenerator == 'number') {
          ttl = cacheKeyGenerator;
          cacheKeyGenerator = undefined;
        }
        if (typeof cacheKeyGenerator == 'function') {
          this._cacher = cacheKeyGenerator;
        }
        this._ttl = ttl;
      }
    };

    var runQuery = function(structuredSql, done){
      if (structuredSql === false || structuredSql === null) {
        done(null, {});
        return;
      }

      if (typeof structuredSql != 'object' || Array.isArray(structuredSql)) {
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
        if (err) {
          done(err);
        } else {
          var topology = topojson.topology(geojsonLayers, {
            'property-transform': function(properties, key, value){
              properties[key] = value;
              return true;
            }
          });
          done(null, topology);
        }
      });
    };

    var gotTile = function(tileOutput){
      parseSql(tileOutput, function(parsingError, structuredSql){
        if (parsingError) {
          self.log('SQL Parsing Error', 'error');
          self.log(parsingError, 'error');
          res.send(500);
          return;
        }
        var cacher = tileContext._cacher || self.defaultCacher || false;

        if (cacher) {
          var cacheKey = cacher(tile);
          var ttl = tileContext._ttl || self.defaultTtl || 3600000;
          self._cache(cacheKey, ttl, function(done){
            self.log('cache miss', 'debug');
            runQuery(structuredSql, function(queryError, topology){
              done(queryError, topology);
            });
          }, function(topoError, topology){
            if (topoError) {
              res.send(500);
              self.log(topoError, 'error');
            } else {
              res.send(topology);
            }
          });
        } else {
          runQuery(structuredSql, function(queryError, topology){
            if (queryError) {
              res.send(500);
              self.log('Error running query', 'error');
              self.log(queryError, 'error');
            } else {
              res.send(topology);
            }
          });
        }
      });
    };

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
    render.raw = function(data){
      res.send(data);
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
    render.empty = function(){
      render.raw({});
    };
    render.error = function(msg){
      render.raw(500);
      self.log(['tile render error', msg]);
    };

    var outputData;

    async.eachSeries(callbacks, function(middleware, next){
      middleware(req, res, tile, function(err, data){
        outputData = data;
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