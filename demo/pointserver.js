// USAGE: node tileserver.js
"use strict";
let Tilesplash = require('tilesplash')

// Set up DB connection params
let config = {
  host: 'localhost',
  port: '5432',
  database: 'tilesplash_demo'
}

let app = new Tilesplash(config)

// Add a cross-origin handler because EVERYTHING IS AWFUL
function cors (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, authorization, content-type')
  next()
}
app.server.use(cors)

// Build the tile layer
app.layer("addresses", (tile, render) => {
  
  // Set up a zoom-based sampling scale to reduce the load on the client
  let sample = 0.1
  if (tile.z >= 12 && tile.z < 14) {
    sample = 0.25
  } else if (tile.z >= 14 && tile.z < 16) {
    sample = 0.5
  } else if (tile.z >= 16) {
    sample = 1
  }
  // Generate the PostGIS query
  let sql = `
    SELECT 
      ST_AsGeoJSON(the_geom) AS the_geom_geojson 
    FROM oa 
    WHERE ST_Intersects(the_geom, !bbox_4326!) 
    AND random() <
  ` + sample
  ;
  render(sql);
});

// Send it to port
app.server.listen(3000)