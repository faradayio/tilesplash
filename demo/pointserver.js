// USAGE: node tileserver.js
"use strict";
let Tilesplash = require('tilesplash')

// set up DB connection params
let config = {
  host: 'localhost',
  port: '5432',
  database: 'tilesplash_demo'
}

let app = new Tilesplash(config)

// add a cross-origin handler because EVERYTHING IS AWFUL
function cors (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, authorization, content-type')
  next()
}
app.server.use(cors)

// build the tile layer
app.layer("addresses", (tile, render) => {
  // Generate the SQL, with 10% sampling to reduce the memory load on the client.
  let sql = `
    SELECT ST_AsGeoJSON(the_geom) AS the_geom_geojson FROM oa WHERE random() < 0.1
  `
  ;
  render(sql);
});

// send it to port
app.server.listen(3000)