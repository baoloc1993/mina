// Chiều cao bàn phím đang mở (0 khi đóng). Edge-to-edge của Expo 57 không tự resize khi mở bàn phím nên UI tự chừa chỗ.
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

export function useKeyboardHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setH(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}
