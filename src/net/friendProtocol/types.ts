export type HandshakeFrameInput = {
  type: "friend_req" | "friend_accept" | "friend_decline";
  convId?: string;
  ts?: number;
  from: {
    identityPub: string;
    dhPub: string;
    deviceId?: string;
    friendCode?: string;
  };
  profile?: {
    displayName?: string;
    status?: string;
    avatarRef?: unknown;
  };
};

export type FriendCodePayload = {
  v: 1;
  commitment: string;
  identityPub: string;
  dhPub: string;
  deviceId?: string;
  onionAddr?: string;
  alternateRouteAddr?: string;
};

export type externalHandshakeRecord = {
  v: 1;
  transcriptHash: string;
  proofSig: string;
};

export type externalContactExchangeRecord = {
  v: 1;
  profileHash: string;
  keyCommitment: string;
  profileSig: string;
};

export type externalKeyAgreementRecord = {
  v: 1;
  method: "identity_dh" | "friend_code_oob_v1";
  nonce: string;
  confirmation: string;
  commitment?: string;
  payload?: string;
  role?: "alice" | "bob";
  masterKeyHint?: string;
  pskHint?: string;
};

export type externalFriendProtocol = {
  v: 1;
  handshake: externalHandshakeRecord;
  contactExchange: externalContactExchangeRecord;
  keyAgreement: externalKeyAgreementRecord;
};

export type ProtocolVerifyResult = {
  ok: boolean;
  reason?: string;
};
