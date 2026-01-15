import * as Y from "yjs";

export type Replica = {
  doc: Y.Doc;
  enabled: boolean;
  connect: () => void;
  disconnect: () => void;
};

export const createReplica = (): Replica => {
  const doc = new Y.Doc();
  return {
    doc,
    enabled: false,
    connect: () => {
      // WebRTC provider wiring will go here. Disabled in MVP.
    },
    disconnect: () => {
      doc.destroy();
    },
  };
};
