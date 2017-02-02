TILESPLASH
==========

A light and quick nodejs webserver for serving topojson and mapbox vector tiles from a [postgis](http://www.postgis.net/) backend. inspired by [Michal Migurski](http://mike.teczno.com/)'s [TileStache](http://tilestache.org/). Works great for powering [Mapbox-GL-based](https://www.mapbox.com/mapbox-gl-js/example/set-perspective/) apps like this:

![example](https://www.dropbox.com/s/viwv9layui7vw7x/Screenshot%202016-10-14%2011.20.03.png?dl=1)

# Dependencies

Tilesplash depends on `node` and `npm`

# Installation

```bash
npm install tilesplash
```

# Example

Here's a simple tile server with one layer

```javascript
var Tilesplash = require('tilesplash');

var app = new Tilesplash('postgres://username@localhost/db_name');

app.layer('test_layer', function(tile, render){
  render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM layer WHERE ST_Intersects(the_geom, !bbox_4326!)');
});

app.server.listen(3000);
```

- Topojson tiles will be available at `http://localhost:3000/test_layer/{z}/{x}/{y}.topojson`
- Mapbox vector tiles will be available at `http://localhost:3000/test_layer/{z}/{x}/{y}.mvt`

(See [client implementation examples](https://github.com/faradayio/tilesplash#client) below)

# Usage

## `new Tilesplash(connection_details, [cacheType])`

creates a new tilesplash server using the given postgres database

```javascript
var app = new Tilesplash('postgres://tiles@localhost/tile_database');
```

To cache using redis, pass `'redis'` as the second argument. Otherwise an in-process cache will be used.

### `Tilesplash.server`

an [express](http://expressjs.com/) object, mostly used internally but you can use it to add middleware for authentication, browser caching, gzip, etc.

### `Tilesplash.layer(name, [middleware, ...], [mvtOptions], callback)`

__name__: the name of your layer. Tiles will be served at /__name__/z/x/y.topojson

__middleware__: a [middleware function](#middleware)

__mvtOptions__: optional [mapnik parameters](http://mapnik.org/documentation/node-mapnik/3.5/#VectorTile.addGeoJSON), e.g. `{ strictly_simple: true }`

__callback__: your tile building function with the following arguments. function([tile](#tile), [render](#render))


#### Simple layer

This layer renders tiles containing geometry from the `the_geom` column in `test_table`

```javascript
app.layer('simpleLayer', function(tile, render){
  render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM test_table WHERE ST_Intersects(the_geom, !bbox_4326!)');
});
```

#### Combined layers

Tilesplash can render tiles from multiple queries at once

```javascript
app.layer('multiLayer', function(tile, render){
  render({
    circles: 'SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM circles WHERE ST_Intersects(the_geom, !bbox_4326!)',
    squares: 'SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM squares WHERE ST_Intersects(the_geom, !bbox_4326!)'
  });
});
```

#### Using mapnik geometry parameters

This layer renders tiles containing geometry features simplified to a threshold of `4`. Full parameters are documented [here](http://mapnik.org/documentation/node-mapnik/3.5/#VectorTile.addGeoJSON).

```javascript
app.layer('simpleLayer', { simplify_distance: 4 }, function(tile, render){
  render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM test_table WHERE ST_Intersects(the_geom, !bbox_4326!)');
});
```

#### Escaping variables

Tilesplash has support for escaping variables in sql queries. You can do so by passing an array instead of a string wherever a sql string is accepted.

```javascript
app.layer('escapedLayer', function(tile, render){
  render(['SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM points WHERE ST_Intersects(the_geom, !bbox_4326!) AND state=$1', 'California']);
});

app.layer('escapedMultiLayer', function(tile, render){
  render({
    hotels: ['SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM hotels WHERE ST_Intersects(the_geom, !bbox_4326!) AND state=$1', 'California'],
    restaurants: ['SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM restaurants WHERE ST_Intersects(the_geom, !bbox_4326!) AND state=$1', 'California']
  });
});
```

#### Restricting zoom level

Sometimes you only want a layer to be visible on certain zoom levels. To do that, we simply render an empty tile when tile.z is too low or too high.

```javascript
app.layer('zoomDependentLayer', function(tile, render){
  if (tile.z < 8 || tile.z > 20) {
    render.empty(); //render an empty tile
  } else {
    render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM points WHERE ST_Intersects(the_geom, !bbox_4326!)');
  }
});
```

You can also adapt your layer by zoom level to show different views in different situations.

In this example we show data from the `heatmap` table when the zoom level is below 8, data from `points` up to zoom 20, and empty tiles when you zoom in further than that.

```javascript
app.layer('fancyLayer', function(tile, render){
  if (tile.z < 8) {
    render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM heatmap WHERE ST_Intersects(the_geom, !bbox_4326!)');
  } else if (tile.z > 20) {
    render.empty();
  } else {
    render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM points WHERE ST_Intersects(the_geom, !bbox_4326!)');
  }
});
```

## Middleware

Middleware allows you to easily extend tilesplash to add additional functionality. Middleware is defined like this:

```javascript
var userMiddleware = function(req, res, tile, next){
  tile.logged_in = true;
  tile.user_id = req.query.user_id;
  next();
};
```

You can layer include this in your layers

```javascript
app.layer('thisOneHasMiddleware', userMiddleware, function(tile, render){
  if (!tile.logged_in) {
    render.error();
  } else {
    render(['SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM placesVisited WHERE ST_Intersects(the_geom, !bbox_4326!) AND visitor=$1', tile.user_id]);
  }
});
```

Middleware can be synchronous or asynchronous, just be sure to call `next()` when you're done!

## tile

`tile` is a parameter passed to middleware and layer callbacks. It is an object containing information about the tile being requested. It will look something like this:

```javascript
{
  x: 100,
  y: 100,
  z: 10,
  bounds: [w, s, e, n] //output from SphericalMercator.bounds(x,y,z) using https://github.com/mapbox/node-sphericalmercator
  bbox: 'BBOX SQL for webmercator',
  bbox_4326: 'BBOX SQL for 4326 projection' //you probably need this
}
```

Anything in __tile__ can be substituted into your SQL query by wrapping it in exclamation marks like `!this!`

You can add custom items into __tile__ like so:

```javascript
tile.table = "states";
render('SELECT ST_AsGeoJSON(the_geom) as the_geom_geojson FROM !table! WHERE !bbox!')
```

Note that when you interpolate tile variables into your queries with the exclamation point syntax, that data will __not be escaped__. This allows you to insert custom SQL from tile variables, like with `!bbox!`, but it can be a security risk if you allow any user input to be interpolated that way.

When you want to use user input in a query, see [Escaping variables](#escaping-variables) above.

## `render`

`render` is the second argument passed to your layer callback function. You can use it to render different kinds of tiles.

### `render(sql)`

Runs a SQL query and displays the result as a tile

### `render(object)`

Runs multiple SQL queries and renders them in seperate topojson layers. See [Combined layers](#combined-layers) above.

### `render.query()`

Alias of render()

### `render.queryFile(fileName)`

Use this if your SQL is really long and/or you want to keep it seperate.

```javascript
app.layer('complicatedLayer', function(tile, render){
  render.queryFile('important_stuff/advanced_tile.sql');
});
```

### `render.empty()`

Renders an empty tile

### `render.error()`

Replies with a 500 error

### `render.raw(string or http code)`

Sends a raw reply. I can't think of any reason you would want to do this, but feel free to experiment.

```javascript
app.layer('smileyLayer', function(tile, render){
  render.raw(':)');
});
```

```javascript
app.layer('notThereLayer', function(tile, render){
  render.raw(404);
});
```

### `render.rawFile(fileName)`

Replies with the specified file

```javascript
app.layer('staticLayer', function(tile, render){
  render.rawFile('thing.topojson');
});
```

## Caching

Caching is very important. By default, Tilesplash uses an in-memory cache. You can use redis instead by passing `'redis'` as the second argument when initializing a Tilesplash server.

There are two ways to implement caching. You can either do it globally or on a layer by layer basis.

### app.cache([keyGenerator], ttl)

Use this to define caching across your entire application

__`keyGenerator(tile)`__

keyGenerator is a function that takes a `tile` object as it's only parameter and returns a cache key (__string__)

If you don't specify a key generator, `app.defaultCacheKeyGenerator` will be used, which returns a key derived from your database connection, tile layer, and tile x, y, and z.

__`ttl`__

TTL stands for time-to-live. It's how long tiles will remain in your cache, and it's defined in milliseconds. For most applications, anywhere between one day (86400000) to one week (604800000) should be fine.

__Example__

In this example, we have `tile.user_id` available to us and we don't want to show one user tiles belonging to another user. By starting with `app.defaultCacheKeyGenerator(tile)` we get a cache key based on things we already want to cache by (like `x`, `y`, and `z`) and we can then add `user_id` to prevent people from seeing cached tiles unless their `user_id` matches.

```javascript
app.cache(function(tile){
  return app.defaultCacheKeyGenerator(tile) + ':' + tile.user_id; //cache by tile.user_id as well
}, 1000 * 60 * 60 * 24 * 30); //ttl 30 days
```

### `this.cache([keyGenerator], ttl)`

Layer-specific caching works identically to global caching as defined above, except that it only applies to one layer and you define it within that layer.

In this example, slowLayer uses the same key generator as the rest of the app, but specifies a longer TTL.

```javascript
app.cache(keyGenerator, 1000 * 60 * 60 * 24); //cache for one day

app.layer('slowLayer', function(tile, render){
  this.cache(1000 * 60 * 60 * 24 * 30); //cache for 30 days

  render.queryFile('slowQuery.sql');
});
```

In this example, only slowLayer is cached.

```javascript
app.layer('fastLayer', function(tile, render){
  render.queryFile('fastQuery.sql');
});

var userMiddleware = function(req, res, tile, next){
  tile.user_id = 1;
  next();
};

app.layer('slowLayer', userMiddleware, function(tile, render){
  this.cache(function(tile){
    return app.defaultCacheKeyGenerator(tile) + ':' + tile.user_id;
  }, 1000 * 60 * 60 * 24); //cache for one day

  render.queryFile('slowQuery.sql');
});
```

## Client
Some in-browser examples of how to use the tiles generated by tilesplash:

### .mvt endpoint
- [Mapbox GL third-party source example](https://www.mapbox.com/mapbox-gl-js/example/third-party/)
- [Mapzen's Tangram](https://github.com/tangrams/tangram)
- [Mapzen's d3 vector tiles implementation](http://mapzen.github.io/d3-vector-tiles)
 
### .topojson endpoint
- [D3 + leaflet](http://bl.ocks.org/wboykinm/7393674)
- [Mapzen Tangram](https://github.com/tangrams/tangram)
