# Tilesplash local demo

This is a simple [Mapbox GL](https://www.mapbox.com/mapbox-gl-js/api/) example of tilesplash in use, serving points from the [openaddresses project](https://openaddresses.io/).

![denver](https://www.dropbox.com/s/oxrn5t7e48pvkum/denver.gif?dl=1)

## Dependencies

- [PostgreSQL](https://www.postgresql.org/download/)
- [PostGIS](http://postgis.net/install/)
- [Node v6+](https://nodejs.org/en/download/)
- [wget](https://www.gnu.org/software/wget/)

## Setup

1. Get a [Mapbox Token](http://mapbox.com/signup) and put it [in index.html](https://github.com/faradayio/tilesplash/blob/master/demo/index.html#L18)

2. Run this collection of should-really-be-in-a-docker-container commands to get sample data and configure the local DB:

```
bash demo_config.sh
```

## Run the demo

From this `demo/` directory:
```
npm install
npm run points
```

Then visit [http://localhost:8000/points.html](http://localhost:8000/points.html) and watch as the glorious city of Denver unfolds in point form.