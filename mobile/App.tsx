// Gốc app Mina (vòng 3): Runtime lo toàn bộ logic (phiên, sync, gói, vòng đời mini app); App chỉ dựng khung + Router.
// Vùng an toàn (thanh trạng thái trên, thanh điều hướng / cử chỉ dưới) lấy từ react-native-safe-area-context, chừa MỘT lần ở gốc.
import React from 'react';
import { LogBox, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useKeyboardHeight } from './src/ui/useKeyboardHeight';
import { Router } from './src/screens/Router';
import { color } from './src/ui/theme';

// Mất mạng là trạng thái bình thường của app offline-first: PowerSync log nó bằng console.error,
// LogBox ở bản dev biến nó thành màn đỏ chặn thao tác. Chỉ ẩn log sync, lỗi khác vẫn hiện.
LogBox.ignoreLogs(['[PowerSync]']);

function Shell() {
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: kb > 0 ? kb : insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <Router />
      <StatusBar style="dark" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
});
