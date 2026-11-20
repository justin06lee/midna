import { Image as RNImage } from "react-native-web";
export const Image = ({ source, style, contentFit }: { source: unknown; style?: unknown; contentFit?: string }) => <RNImage source={source as never} style={style as never} resizeMode={contentFit === "contain" ? "contain" : "cover"} />;
