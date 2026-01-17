import { sweepExpired } from "../policies/deliveryPolicy";

let timer: ReturnType<typeof setInterval> | null = null;

export const startOutboxScheduler = () => {
  if (timer) return;
  void sweepExpired();
  timer = setInterval(() => {
    void sweepExpired();
  }, 5 * 60 * 1000);
};

export const stopOutboxScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
