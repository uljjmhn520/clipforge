import sharp from "sharp";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export interface SlicedKeyframe {
  index: number; // 1-based (1~9)
  filePath: string;
  width: number;
  height: number;
}

/**
 * 将一张 3x3 九宫格大图 (9:16 比例) 等分裁切为 9 张独立的 9:16 关键帧切片
 */
export async function slice3x3GridImage(
  gridImagePath: string,
  outputDir: string
): Promise<SlicedKeyframe[]> {
  if (!existsSync(gridImagePath)) {
    throw new Error(`九宫格原图文件不存在: ${gridImagePath}`);
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 1. 获取原图元数据
  const image = sharp(gridImagePath);
  const metadata = await image.metadata();

  const totalWidth = metadata.width || 2304;
  const totalHeight = metadata.height || 4096;

  // 2. 计算单个格子的尺寸 (3x3 等分)
  const cellWidth = Math.floor(totalWidth / 3);
  const cellHeight = Math.floor(totalHeight / 3);

  const results: SlicedKeyframe[] = [];

  // 3. 循环裁切 9 个格子 (行 0~2, 列 0~2)
  let cellIndex = 1;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const left = col * cellWidth;
      const top = row * cellHeight;

      const outputFileName = `shot_${String(cellIndex).padStart(2, "0")}.png`;
      const outputPath = join(outputDir, outputFileName);

      await sharp(gridImagePath)
        .extract({
          left,
          top,
          width: cellWidth,
          height: cellHeight,
        })
        .png({ quality: 95 })
        .toFile(outputPath);

      results.push({
        index: cellIndex,
        filePath: outputPath,
        width: cellWidth,
        height: cellHeight,
      });

      cellIndex++;
    }
  }

  return results;
}

/**
 * 单格替换功能：当某一个分镜人脸崩坏或商品瑕疵时，支持单独上传一张图片替换该格
 */
export async function replaceSingleCell(
  newSourceImagePath: string,
  targetShotPath: string,
  targetWidth = 720,
  targetHeight = 1280
): Promise<void> {
  if (!existsSync(newSourceImagePath)) {
    throw new Error(`替换源图不存在: ${newSourceImagePath}`);
  }

  // 强制以 cover 模式裁剪至标准竖屏尺寸
  await sharp(newSourceImagePath)
    .resize(targetWidth, targetHeight, { fit: "cover", position: "center" })
    .png({ quality: 95 })
    .toFile(targetShotPath);
}
