# set up a testing environment for tilesplash using data from openaddresses

# get the data
wget -c https://s3.amazonaws.com/data.openaddresses.io/runs/227042/us/co/denver.zip
# when feeling more ambitious, use all of the US West (~1GB):
# wget -c https://s3.amazonaws.com/data.openaddresses.io/openaddr-collected-us_west.zip
unzip denver.zip

# create and configure the db
dropdb tilesplash_demo --if-exists
createdb tilesplash_demo
psql tilesplash_demo -c "CREATE EXTENSION IF NOT EXISTS postgis"
psql tilesplash_demo -c "CREATE TABLE oa (
  lon float,
  lat float,
  number text,
  street text,
  unit text,
  city text,
  district text,
  region text,
  postcode text,
  id text,
  hash text
)"
psql tilesplash_demo -c "\COPY oa FROM 'us/co/denver.csv' CSV HEADER"
psql tilesplash_demo -c "SELECT AddGeometryColumn ('public','oa','the_geom',4326,'GEOMETRY',2)"
psql tilesplash_demo -c "UPDATE oa SET the_geom = ST_GeomFromText('POINT(' || lon || ' ' || lat || ')',4326)"

echo "Ready to run the demo!"