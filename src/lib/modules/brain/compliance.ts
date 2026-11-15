/**
 * 电商广告法合规词库与脱敏拦截器
 * 针对极限词、虚假疗效、伪造稀缺等高风险词汇进行前置扫描与强制替换。
 */

export interface ComplianceViolation {
  word: string;
  category: string;
  replacement: string;
  index: number;
}

export const AD_FORBIDDEN_RULES: Array<{ pattern: RegExp; replacement: string; category: string }> = [
  // 1. 绝对化极限用语
  { pattern: /国家级|国宝级/g, replacement: "专业级", category: "绝对化极限词" },
  { pattern: /第一(名|品牌|名牌|款)?/g, replacement: "排头兵", category: "绝对化极限词" },
  { pattern: /最高级|顶尖|顶级|极品/g, replacement: "高品质", category: "绝对化极限词" },
  { pattern: /全网最(低|便宜|划算|强)/g, replacement: "性价比出众", category: "绝对化极限词" },
  { pattern: /独家(绝版)?/g, replacement: "精选", category: "绝对化极限词" },
  { pattern: /史无前例|空前绝后/g, replacement: "诚意满满", category: "绝对化极限词" },
  { pattern: /首选|唯一/g, replacement: "优选", category: "绝对化极限词" },
  
  // 2. 虚假夸大与绝对功效保证
  { pattern: /百分之百(有效|包瘦|治好)?|100%/g, replacement: "显著", category: "绝对保证" },
  { pattern: /包瘦|根治|必愈|断根/g, replacement: "辅助改善", category: "虚假疗效" },
  { pattern: /一秒见效|立竿见影|立刻见效/g, replacement: "快速感受", category: "虚假疗效" },
  { pattern: /无任何副作用|零风险/g, replacement: "温和配方", category: "绝对保证" },
  
  // 3. 诱导性虚假稀缺
  { pattern: /错过(等|再等)一年/g, replacement: "优惠不容错过", category: "虚假稀缺" },
  { pattern: /最后(三|3|一|1)件/g, replacement: "数量有限", category: "虚假稀缺" },
  
  // 4. 假冒权威
  { pattern: /特供|专供|军需|政府机构推荐/g, replacement: "定制甄选", category: "假冒权威" },
];

/**
 * 扫描文本中的广告法违禁词
 */
export function scanAdCompliance(text: string): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];
  for (const rule of AD_FORBIDDEN_RULES) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(rule.pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      violations.push({
        word: match[0],
        category: rule.category,
        replacement: rule.replacement,
        index: match.index,
      });
    }
  }
  return violations;
}

/**
 * 自动净化脱敏文本中的广告法违禁词
 */
export function sanitizeAdText(text: string): { cleanText: string; replacedCount: number } {
  let cleanText = text;
  let replacedCount = 0;
  for (const rule of AD_FORBIDDEN_RULES) {
    if (rule.pattern.test(cleanText)) {
      cleanText = cleanText.replace(rule.pattern, () => {
        replacedCount++;
        return rule.replacement;
      });
    }
  }
  return { cleanText, replacedCount };
}
