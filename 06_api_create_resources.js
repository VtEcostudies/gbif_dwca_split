/*
  Author: Jason Loomis

  Project: gbif_dwca_split
  Parse aggregate GBIF download DWcA into individual datasets/providers.
  Goal being then to ingest each dataset into VAL as a separate data resource.

  File: sync_create_resources.js

  Specifics:
  - use config.js to define a local folder holding source data, remote url hosting collectory API
  - use local datasetKey_gbifArray.txt to iterate over datasetKeys and create a local array
  - call GBIF API for datasetKey dependent data (not all was added to the original aggregate download)
  - Create (POST) or Update (PUT) LA Collectory Resources from datasetKey data gathered from GBIF
  - Zip DwCA dataset files into archive named 'datasetKey.zip'
  - Upload DwCA archive to LA Collectory node public folder (eg. 'gbif_split')

  ToDo:
  - zip DwCA dataset files into archive named 'datasetKey.zip'
  - upload data file to the server for ingestion

  Notes:
  For each datasetKey, POST/PUT to the VAL API:

  val-docker (spring of 2019):
  http://beta.vtatlasoflife.org/collectory/ws/{resourceType}/{typeId}

  val-ansible-production (fall of 2019):
  https://collectory.vtatlasoflife.org/ws/{}/{}

  to create/update resources for dataset upload and ingestion:

  - dataResources

  Assumptions:
  - occurrence_split has successfully run against occurrence.txt.
  - gbifIds in citation.txt are a subset of those in occurrence.txt
  - gbifIds uniquely map to a single GBIF datasetKey
  - datasetKey is a persistent, immutable value we can use to create
    citation.txt (and others)
*/
var readline = require('readline');
var fs = require('fs');
var paths = require('./00_config').paths;
var urls =  require('./00_config').urls;
var Request = require('request');
const moment = require('moment');

var sDir = paths.splitDir; //path to directory to hold split GBIF DWcA files
var logFile = `${moment().format('YYYYMMDD-HHMMSS')}_api_create_resources.log`;
var logToConsole = true; //console logging is OK here, speed is dictated by synchronous API calls
var wStream = [];
var dArr = [];
var idx = 0; //file row index
var dryRun = false;

log(`config paths: ${JSON.stringify(paths)}`);

var dRead = readline.createInterface({
  input: fs.createReadStream(`${sDir}/datasetKey_gbifArray.txt`)
});

//load the datasetKey_gbifArray file into local array
dRead.on('line', function (row) {
  idx++;
  var arr = row.split(":");
  var mod = arr.slice(); //using .slice() copies by value, not by reference

  var dKey = mod[0];
  dArr[idx] = dKey;

  log(`read line: ${idx} datasetKey: ${dKey}`);
});

dRead.on('close', async function() {
  var gbif = null;
  var alaDR = [];
  /*
    Note: A simple for loop is synchronous, which is critical for proper API updates.
    I tried for days to make an asynchrous loop (array.forEach()) do synchronous
    stepwise API updates, and couldn't. A random search on Stack Overflow found
    a comment about synch vs async loop structure. Voila.
  */
  for (var idx=1; idx < (dryRun?10:dArr.length); idx++) { //for testing...
    gbif = await getGbifDataset(idx, dArr[idx]);
    if (gbif) {
      log(`GBIF Dataset Title: ${gbif.title}`);
      alaDR = await getAlaDataResource(idx, dArr[idx]);
      if (!dryRun) {
        if (alaDR.length == 0) {
          log('ALA Data Resource NOT found.');
          await postAlaDataResource(idx, dArr[idx], gbif);
        } else if (alaDR.length == 1) {
          log(`ALA Data Resource found | UID: ${alaDR[0].uid} | resourceType: ${alaDR[0].resourceType} | contentTypes: ${alaDR[0].contentTypes}`);
          await putAlaDataResource(idx, dArr[idx], alaDR[0], gbif);
        } else {
          log(`ERROR: ALA Data Resource GUID ${dArr[idx]} has ${alaDR.length} entries.`);
        }
      } else { //dryRun - test output
        var test = gbifToAlaDataset(gbif, alaDR);
        log(`resourceType: ${test.resourceType}`);
        log(`contentTypes: ${test.contentTypes}`);
      }
    }
  }
});

function getGbifDataset(idx, dKey) {
  var parms = {
    url: `http://api.gbif.org/v1/dataset/${dKey}`,
    json: true
  };

  return new Promise((resolve, reject) => {
    Request.get(parms, (err, res, body) => {
      log(`GBIF Dataset | ${idx} | dataset | ${dKey} | ${res.statusCode}`);
      if (err) {
        reject(err);
      } else if (res.statusCode > 399) {
        reject(body);
      } else {
        resolve(body);
      }
    });
  });
}

function getAlaDataResource(idx, dKey) {
  var parms = {
    url: `${urls.collectory}/ws/dataResource?guid=${dKey}`,
    json: true
  };

  return new Promise((resolve, reject) => {
    Request.get(parms, (err, res, body) => {
      log(`GET ALA Data Resource | ${idx} | dataset | ${dKey} | ${res.statusCode}`);
      if (err || res.statusCode > 399) {
        log(`ERROR | in getAlaDataResource | err:${err?err:undefined} | result:${res?res.statusCode:undefined}`);
        reject([]); //expecting an array returned...
      } else {
        resolve(body);
      }
    });
  });
}

function postAlaDataResource(idx, dKey, gbif) {
  var pBody = gbifToAlaDataset(gbif); //POST Body - create data format for LA Collectory from GBIF

  var parms = {
    url: `${urls.collectory}/ws/dataResource`,
    body: pBody,
    json: true
  };

  return new Promise((resolve, reject) => {
    Request.post(parms, (err, res, body) => {
      log(`POST ALA Data Resource | ${idx} | dataset | ${dKey} | ${res.statusCode}`);
      if (err || res.statusCode > 399) {
        reject(err);
      } else {
        resolve(body);
      }
    });
  });
}

function putAlaDataResource(idx, dKey, alaDR, gbif) {
  var pBody = gbifToAlaDataset(gbif, alaDR); //PuT Body - create data format for LA Collectory from GBIF

  var parms = {
    url: `${urls.collectory}/ws/dataResource/${alaDR.uid}`,
    body: pBody,
    json: true
  };

  return new Promise((resolve, reject) => {
    Request.put(parms, (err, res, body) => {
      log(`PUT ALA Data Resource | ${idx} | dataset | ${dKey} | ${res.statusCode}`);
      if (err || res.statusCode > 399) {
        reject(err);
      } else {
        resolve(body);
      }
    });
  });
}

/*
NOTE: The ALA collectory insertable fields are found here:
https://github.com/AtlasOfLivingAustralia/collectory-plugin/blob/2ed9737c04db9a07fe9052d40ece43c4e5a2b207/grails-app/services/au/org/ala/collectory/CrudService.groovy#L19
baseStringProperties =
    ['guid','name','acronym','phone','email','state','pubShortDescription',
    'pubDescription','techDescription','notes', 'isALAPartner','focus','attributions',
    'websiteUrl','networkMembership','altitude', 'street','postBox','postcode','city',
    'state','country','file','caption','attribution','copyright', 'gbifRegistryKey']
    https://github.com/AtlasOfLivingAustralia/collectory-plugin/blob/2ed9737c04db9a07fe9052d40ece43c4e5a2b207/grails-app/services/au/org/ala/collectory/CrudService.groovy#L33
dataResourceStringProperties =
    ['rights','citation','dataGeneralizations','informationWithheld',
    'permissionsDocument','licenseType','licenseVersion','status','mobilisationNotes','provenance',
    'harvestingNotes','connectionParameters','resourceType','permissionsDocumentType','riskAssessment',
    'filed','publicArchiveAvailable','contentTypes','defaultDarwinCoreValues', 'imageMetadata',
    'geographicDescription','northBoundingCoordinate','southBoundingCoordinate','eastBoundingCoordinate',
    'westBoundingCoordinate','beginDate','endDate','qualityControlDescription','methodStepDescription',
    'gbifDoi']
*/
function gbifToAlaDataset(gbif, alaDR={}) {
  var resourceType = 'records';

  //some values need processing. do that first.
  resourceType = gbif.type=='CHECKLIST'?'species-list':
                (gbif.type=='OCCURRENCE'?'records':
                (gbif.type=='SAMPLING_EVENT'?'records':'records'));

  // Don't change all nulls to empty strings (""). Some fields require null or non-empty string.
  var url = `https://www.gbif.org/occurrence/search?dataset_key=${gbif.key}&geometry=POLYGON((-73.38789 45.02072,-73.41743 44.62239,-73.32404 44.47363,-73.47236 44.0606,-73.39689 43.77059,-73.47379 43.57988,-73.39689 43.54406,-73.33646 43.60972,-73.29252 43.56197,-73.29252 42.73641,-72.52897 42.73238,-72.44108 42.99409,-72.28178 43.65346,-72.0593 43.8992,-72.01536 44.21698,-71.51548 44.48409,-71.47627 45.01296,-73.38789 45.02072))&has_coordinate=true&has_geospatial_issue=false`;
  var ala = {
      "name": `${gbif.title} (Vermont)`,
      //"acronym": "",
      "guid": gbif.key,
      "street": gbif.contacts[0].address[0],
      "postBox": "",
      "postcode": gbif.contacts[0].postalCode,
      "city": gbif.contacts[0].city,
      "state": gbif.contacts[0].province,
      "country": gbif.contacts[0].country,
      "phone": gbif.contacts[0].phone[0],
      "email": gbif.contacts[0].email[0],
      "pubShortDescription": "",
      "pubDescription": `${gbif.description} (Vermont)`,
      "techDescription": `<a href=${url}>${url}</a>`,
      "focus": "",
      "websiteUrl": gbif.enpoints[0]?gbif.enpoints[0].url?"", //gbif.homepage,
      "networkMembership": null, //can't be empty string
      "hubMembership": [],
      "taxonomyCoverageHints": [],
      "attribution": "",
      "attributions": [], //gbif.contacts,
      "rights": gbif.license,
      "licenseType": "",
      "licenseVersion": "",
      "citation": gbif.citation.text,
      "resourceType": resourceType,
      "dataGeneralizations": "",
      "informationWithheld": "",
      "permissionsDocument": "",
      "permissionsDocumentType": "Other",
      "contentTypes": [
          "gbif import"
      ],
      "connectionParameters": {
          "protocol": "DwCA",
          "url": `${urls.primary}/gbif-split/${gbif.key}.zip`,
          "termsForUniqueKey": [
              "gbifID"
          ]
      },
      "hasMappedCollections": false,
      "status": "identified",
      "provenance": "", //can't be null. can be empty string.
      "harvestFrequency": 0,
      //"dataCurrency": null, //not a valid field
      "harvestingNotes": "",
      "publicArchiveAvailable": true,
      //"publicArchiveUrl": `${urls.collectory}/archives/gbif/${alaDR.uid}/${alaDR.uid}.zip`,
      //"gbifArchiveUrl": `${urls.collectory}/archives/gbif/${alaDR.uid}/${alaDR.uid}.zip`,
      "downloadLimit": 0,
      "gbifDataset": true,
      "isShareableWithGBIF": true,
      "verified": false,
      "gbifRegistryKey": gbif.key,
      "beginDate": gbif.temporalCoverages[0]?gbif.temporalCoverages[0].start?null,
      "endDate": gbif.temporalCoverages[0]?gbif.temporalCoverages[0].end?null,
      "gbifDoi": gbif.doi //output value 'doi' is not proper. this does not work - cannot set via the API
  };

  switch(gbif.type) {
    case 'OCCURRENCE':
      ala.contentTypes.push("point occurrence data");
      break;
    case 'SAMPLING_EVENT':
      ala.contentTypes.push("point occurrence data");
      break;
    case 'CHECKLIST':
      ala.contentTypes.push("species-list");
      break;
  }

  return ala;
}

async function log(txt, override=false) {
  try {
    if (logToConsole || override) {console.log(txt);}
    if (!wStream['log']) {
      wStream['log'] = await fs.createWriteStream(`${sDir}/${logFile}`);
    }
    if (typeof txt == 'object') { //handles arrays and objects
      var obj = txt;
      txt = '';
      for (key in obj) {
        txt += `${key}:${obj[key]}\n`;
      }
    }
    wStream['log'].write(txt + '\n');
  } catch(error) {
    console.log(`log error: ${error}`);
  }
}
