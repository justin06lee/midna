import { requireNativeModule } from "expo";

/** The phone's location through expo-task-manager (modules/midna-location/ios). */
interface MidnaLocation {
  /**
   * Start, or change, what runs: significant changes (about 500 m, and they relaunch the app iOS ended), and with
   * `precise` a GPS fix every 30 m while moving (only with Always). iOS runs the task named so, defined with
   * TaskManager.defineTask, with each fix; a silent push from midna brings one more ("requested").
   */
  startTracking(taskName: string, precise: boolean): Promise<void>;
  stopTracking(taskName: string): Promise<void>;
  isTracking(taskName: string): Promise<boolean>;
  /** Whether Precise Location is on for midna in iPhone Settings. */
  hasPreciseAccuracy(): boolean;
}

export default requireNativeModule<MidnaLocation>("MidnaLocation");
