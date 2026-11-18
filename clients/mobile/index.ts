import { registerRootComponent } from "expo";
// The background location tasks are defined first: iOS relaunching the app for a move finds them before anything else.
import "./src/location";
// And the alarms' task, which a silent push from midna launches the app for.
import "./src/alarms";
import App from "./src/App";

registerRootComponent(App);
