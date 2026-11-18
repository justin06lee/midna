import { registerRootComponent } from "expo";
// The background location tasks are defined first: iOS relaunching the app for a move finds them before anything else.
import "./src/location";
// And the alarms' task, which a silent push from midna launches the app for.
import "./src/alarms";
// So is the Screen Time push's task: midna's rules can wake the app while it is closed.
import "./src/focus";
import App from "./src/App";

registerRootComponent(App);
