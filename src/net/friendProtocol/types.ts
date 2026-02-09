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
  method: "identity_dh";
  nonce: string;
  confirmation: string;
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

