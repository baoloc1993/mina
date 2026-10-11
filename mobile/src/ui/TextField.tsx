// C3 ô nhập: trống · đang gõ (viền primary) · lỗi (viền + dòng lỗi danger) · tắt.
import React, { useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Txt } from './Txt';
import { color, fontSize, radius, space, stroke, tapMin, lineHeight } from './theme';

interface Props
  extends Pick<
    TextInputProps,
    'keyboardType' | 'maxLength' | 'autoCapitalize' | 'autoComplete' | 'autoCorrect' | 'textContentType' | 'returnKeyType' | 'onSubmitEditing' | 'autoFocus' | 'inputMode'
  > {
  label: string;
  value: string;
  onChangeText(v: string): void;
  placeholder?: string;
  error?: string | null;
  /** Viền lỗi mà không hiện dòng lỗi (dòng lỗi vẽ nơi khác để không đẩy nút). */
  invalid?: boolean;
  hint?: string;
  disabled?: boolean;
  testID?: string;
}

export function TextField({ label, value, onChangeText, placeholder, error, invalid, hint, disabled, testID, ...rest }: Props) {
  const [focused, setFocused] = useState(false);
  const bad = !!error || !!invalid;
  const borderColor = bad ? color.danger : focused ? color.primary : color.border;
  return (
    <View style={styles.field}>
      <Txt size="sm" weight="label">
        {label}
      </Txt>
      <TextInput
        {...rest}
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color['text-muted']}
        selectionColor={color.primary}
        cursorColor={color.primary}
        editable={!disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          { borderColor, borderWidth: focused || bad ? stroke.focus : stroke.thin },
          disabled && styles.disabled,
        ]}
      />
      {error ? (
        <Txt size="sm" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Txt>
      ) : hint ? (
        <Txt size="sm" tone="muted">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.xs, alignSelf: 'stretch' },
  input: {
    minHeight: tapMin,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    color: color.text,
    fontSize: fontSize.base,
    lineHeight: lineHeight(fontSize.base),
  },
  disabled: { backgroundColor: color.surface, color: color['text-muted'] },
});
