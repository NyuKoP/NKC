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
};

export type FriendHandshakeRecord = {
  v: 1;
  transcriptHash: string;
  proofSig: string;
};

export type FriendContactExchangeRecord = {
  v: 1;
  profileHash: string;
  keyCommitment: string;
  profileSig: string;
};

export type FriendKeyAgreementRecord = {
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

export type FriendControlProtocol = {
  v: 1;
  handshake: FriendHandshakeRecord;
  contactExchange: FriendContactExchangeRecord;
  keyAgreement: FriendKeyAgreementRecord;
};

export type ProtocolVerifyResult = {
  ok: boolean;
  reason?: string;
};
