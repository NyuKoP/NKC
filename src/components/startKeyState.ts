export const isStartKeyCompletionDisabled = ({
  busy,
  alreadyConfirmed,
  startKey,
  confirmed,
}: {
  busy: boolean;
  alreadyConfirmed: boolean;
  startKey: string;
  confirmed: boolean;
}) => busy || !confirmed || (!alreadyConfirmed && !startKey);
