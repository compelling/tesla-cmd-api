import fs from 'fs';
import eckey from 'eckey-utils';
import { FleetApi } from './src/FleetApi.js';
import { CarServer } from './src/CarServer.js';


if (process.argv.length <= 6) {
    console.error('Expected at 5 arguments: clientId vin accessToken action actionParam');
    process.exit(1);
  }
  // index 0 is node, 2 is index.js
  const clientId = process.argv[2];
  const vin = process.argv[3];
  const accessToken = process.argv[4];
  const action = process.argv[5];
  const actionParam = process.argv[6];
  console.log('Got arguments', {clientId, vin, accessToken, action, actionParam});
   
// Load private and public keys
const key = eckey.parsePem(fs.readFileSync('private.pem', 'utf8').trim());

// Fleet api config
const fleetApi = new FleetApi(clientId, accessToken);

// CarServer initialization
const cmdApi = new CarServer(fleetApi, vin, key);

if (action === "chargingSetLimit") await cmdApi.chargingSetLimit(actionParam);
if (action === "chargingStartStop") await cmdApi.chargingStartStop(actionParam);
if (action === "setChargingAmps") await cmdApi.setChargingAmps(actionParam);
