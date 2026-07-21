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
  lokinetAddr?: string;
};

export type BriarHandshakeRecord = {
  v: 1;
  transcriptHash: string;
  proofSig: string;
};

export type BriarContactExchangeRecord = {
  v: 1;
  profileHash: string;
  keyCommitment: string;
  profileSig: string;
};

export type BriarKeyAgreementRecord = {
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

export type BriarFriendProtocol = {
  v: 1;
  handshake: BriarHandshakeRecord;
  contactExchange: BriarContactExchangeRecord;
  keyAgreement: BriarKeyAgreementRecord;
};

export type ProtocolVerifyResult = {
  ok: boolean;
  reason?: string;
};
