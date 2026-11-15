/**
 * Voice Grounding（人声落地与环境底噪工程）
 * 彻底消除 AI TTS 的数字真空感与播音腔，让配音自然融入真实生活场景。
 */

/**
 * 针对配音人声流的麦克风特征化滤镜：
 * 1. 模拟手机麦克风物理频段：90Hz 高通 + 9500Hz 低通
 * 2. 动态压缩 (AGC 风格，3:1 压缩比)
 * 3. 6000Hz 轻度高频激励，增加咬字唇齿感
 */
export const VOICE_DE_BROADCAST_FILTER =
  "highpass=f=90,lowpass=f=9500," +
  "acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=2," +
  "aexciter=amount=2:drive=8.5:freq=6000";

/**
 * 合成真实生活环境底噪 (模拟空调/室内轻微空气流动声)
 * 使用 lavfi 内置的 anoisesrc 生成微弱布朗噪声，彻底消灭句子间的绝对静音 (-58dB)
 */
export function buildRoomToneSource(amplitude = 0.008): string {
  return (
    `anoisesrc=colour=brown:r=44100:amplitude=${amplitude},` +
    `lowpass=f=400,aformat=sample_rates=44100:channel_layouts=stereo`
  );
}
