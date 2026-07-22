export class AdaptiveTransferWindow {
  private window = 1;
  private successStreak = 0;
  private readonly maximum: number;
  private readonly promotionThreshold: number;

  constructor(maximum = 2, promotionThreshold = 3) {
    this.maximum = maximum;
    this.promotionThreshold = promotionThreshold;
  }

  get current() {
    return this.window;
  }

  onSuccess() {
    this.successStreak += 1;
    if (this.window === 1 && this.maximum > 1 && this.successStreak >= this.promotionThreshold) {
      this.window = this.maximum;
      this.successStreak = 0;
    }
    return this.window;
  }

  onFailure() {
    this.window = 1;
    this.successStreak = 0;
    return this.window;
  }
}
