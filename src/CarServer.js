
import protobuf from "protobufjs";
import { Signer } from './Signer.js';
import { randomBytes } from 'crypto'

const EXPIRES_IN = 15; // default 5 sec

const protoSignatures = await protobuf.load('proto/signatures.proto');
const protoMessage = await protobuf.load('proto/universal_message.proto');
const protoCarServer = await protobuf.load('proto/car_server.proto');
const Domain = protoMessage.lookupEnum("UniversalMessage.Domain").values;
const msgProto = protoMessage.lookupType("UniversalMessage.RoutableMessage");
const sessionInfoProto = protoSignatures.lookupType("Signatures.SessionInfo");
const carServerResponseProto = protoCarServer.lookupType('CarServer.Response');
const actionProto = protoCarServer.lookupType("CarServer.Action");
const ActionResult = protoCarServer.lookupEnum('CarServer.OperationStatus_E').values;
const MessageFault = protoMessage.lookupEnum("UniversalMessage.MessageFault_E").values;
const DOMAIN_INFOTAINMENT = Domain.DOMAIN_INFOTAINMENT;
const DOMAIN_VEHICLE_SECURITY = Domain.DOMAIN_VEHICLE_SECURITY;

class CarServer {
    constructor(fleetApi, vin, privateKey) {
        this.api = fleetApi;
        this.vin = vin;
        this.privateKey = privateKey;
        this.signer = null;
    }

    async #sendRequest(req) {
        console.log('sendRequest req', req);
        const message = msgProto.create(req);
        const buffer = msgProto.encode(message).finish();
        const bufResp = await this.api.signedCommand(this.vin, buffer);
        const res = msgProto.decode(bufResp);
        // Check destination, domain and address
        if (!res.hasOwnProperty('fromDestination')) 
            throw new Error('Missing response source');
        if (!res.fromDestination.hasOwnProperty('domain') || res.fromDestination.domain != req.toDestination.domain)
            throw new Error('Invalid source domain');
        if (!res.hasOwnProperty('toDestination')) 
            throw new Error('Missing response destination');
        if (!res.toDestination.hasOwnProperty('routingAddress') 
            || Buffer.compare(res.toDestination.routingAddress, req.fromDestination.routingAddress) != 0)
            throw new Error('Invalid destination address');
        if (!res.hasOwnProperty('requestUuid'))
            throw new Error('Missing request UUID');
        console.log('sendRequest res', res);
        // Update session
        if (res.hasOwnProperty('sessionInfo') && res.hasOwnProperty('signatureData')) {
            if (!res.signatureData.hasOwnProperty('sessionInfoTag') || !res.signatureData.sessionInfoTag.hasOwnProperty('tag'))
                throw new Error('Missing sessionInfo tag');
            const sessionInfo = sessionInfoProto.decode(res.sessionInfo);
            this.signer = new Signer(this.privateKey, this.vin, sessionInfo);
            if (!this.signer.validateSessionInfo(res.sessionInfo, res.requestUuid, res.signatureData.sessionInfoTag.tag)) {
                this.signer = null;
                throw new Error("Session info hmac invalid");
            }
            // Return error if request timed out
            if (res.hasOwnProperty('signedMessageStatus') && res.signedMessageStatus.hasOwnProperty('operationStatus')){
                if (res.signedMessageStatus.operationStatus != this.ActionResult.OPERATIONSTATUS_OK){
                    throw new Error("Signed message error: "+this.MessageFault[res.signedMessageStatus.signedMessageFault]);
                }
            }
            return sessionInfo;
        }
        // Return response payload
        else if (res.hasOwnProperty('signedMessageStatus') && res.signedMessageStatus.hasOwnProperty('operationStatus')){
            // Return error
            if (res.signedMessageStatus.operationStatus != ActionResult.OPERATIONSTATUS_OK){
                throw new Error("Signed message error: " + MessageFault[res.signedMessageStatus.signedMessageFault]);
            }
        }
        else if (res.hasOwnProperty('protobufMessageAsBytes')) {
            return carServerResponseProto.decode(res.protobufMessageAsBytes);
        }
        else {
            throw new Error("Invalid response: " + JSON.stringify(res));
        }
    }

    async startSession() {
        await this.#sendRequest({
            toDestination: { domain: this.domain },
            fromDestination: { routingAddress: randomBytes(16) },
            sessionInfoRequest: { publicKey: this.privateKey.publicKey },
            uuid: randomBytes(16)
        });
    }

    #decodeError(resultReason) {
        if (resultReason.hasOwnProperty('plainText')) return resultReason.plainText;
        throw new Error('Unknown result Reason');
    }

    async #requestAction(action) {
        if (this.signer == null) await this.startSession();
        if (this.signer == null) throw new Error('Session not started');
        const payload = actionProto.create({ vehicleAction: action });
        const encodedPayload = actionProto.encode(payload).finish();
        const signature = this.signer.generateSignature(encodedPayload, this.domain, EXPIRES_IN);
        const response = await this.#sendRequest({
            toDestination: { domain: this.domain },
            fromDestination: { routingAddress: randomBytes(16) },
            protobufMessageAsBytes: encodedPayload,
            signatureData: signature,
            uuid: randomBytes(16),
            flags: 0
        });
        if (response.hasOwnProperty('actionStatus') && ( response.actionStatus.hasOwnProperty('result') || response.actionStatus.result != undefined) ) {
            switch(response.actionStatus.result) {
                case ActionResult.OPERATIONSTATUS_OK:
                    return;
                case ActionResult.OPERATIONSTATUS_ERROR:
                    if (response.actionStatus.hasOwnProperty('resultReason')){
                        if (response.actionStatus.resultReason.plainText == 'already_set'){
                            // If value was already set, it's not an error!
                            return;
                        }
                        throw new Error(this.#decodeError(response.actionStatus.resultReason));
                    }
                    else
                        throw new Error('Unknown error');
                default:
                    throw new Error('Invalid CarServer action result');
            }
        }
    }

    async chargingSetLimit(percent) {
        this.domain = DOMAIN_INFOTAINMENT;
        await this.#requestAction({ chargingSetLimitAction: { percent } });
    }

    async chargingStartStop(action) {
        this.domain = DOMAIN_VEHICLE_SECURITY;
        const charging_action = (action === "start" ? 2 : 5); // see message ChargingStartStopAction
        await this.#requestAction({ chargingStartStopAction: { charging_action } });
    }

    async setChargingAmps(charging_amps) {
        this.domain = DOMAIN_INFOTAINMENT;
        await this.#requestAction({ setChargingAmpsAction: { charging_amps } });
    }
}

export { CarServer }