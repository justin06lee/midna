import { requireNativeModule } from "expo";

/** iOS's significant location changes through expo-task-manager (modules/midna-location/ios/MidnaLocationModule.swift). */
interface MidnaLocation {
  /** iOS runs the task named so, defined with TaskManager.defineTask, each time the phone has moved about 500 m. */
  startSignificantChanges(taskName: string): Promise<void>;
  stopSignificantChanges(taskName: string): Promise<void>;
  hasStartedSignificantChanges(taskName: string): Promise<boolean>;
}

export default requireNativeModule<MidnaLocation>("MidnaLocation");
