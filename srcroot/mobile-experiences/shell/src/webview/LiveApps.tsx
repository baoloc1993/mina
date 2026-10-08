// Vùng S5: render WebView của MỌI app đang sống (tối đa 3); chỉ app `foreground` hiện, các app nền ẩn nhưng còn chạy.
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { MiniAppHost } from './MiniAppHost';

export function LiveApps({ style }: { style?: StyleProp<ViewStyle> }) {
  const st = useRuntime();
  return (
    <View style={[{ flex: 1 }, style]}>
      {st.live.map((id) => {
        const info = runtime.appInfo(id);
        return info ? <MiniAppHost key={id} appId={id} info={info} visible={st.foreground === id} runtime={runtime} /> : null;
      })}
    </View>
  );
}
