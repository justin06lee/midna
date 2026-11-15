import { registerRootComponent } from "expo";
// The background location tasks are defined first: iOS relaunching the app for a move finds them before anything else.
import "./src/location";
import App from "./src/App";

registerRootComponent(App);
