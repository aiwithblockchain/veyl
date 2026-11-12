const VENDORS = [
  { name: "示例供应商 A", region: "亚洲 · 示例", lines: "12 条线路 · VLESS" },
  { name: "示例供应商 B", region: "全球 · 示例", lines: "26 条线路 · Trojan" },
  { name: "示例供应商 C", region: "欧洲 · 示例", lines: "9 条线路 · Shadowsocks" },
];

interface Props {
  onBack: () => void;
}

export function VendorMarketPage({ onBack }: Props) {
  return (
    <div className="vendor-page">
      <button type="button" className="new-config__back vendor-page__back" onClick={onBack}>
        ← 返回新建配置
      </button>

      <div className="vendor-page__head">
        <h3 className="vendor-page__title">供应商广场</h3>
        <p className="vendor-page__lead">这里会列出可选的机场和节点供应商。</p>
        <p className="vendor-page__lead">现在展示的是示例，暂不能购买或跳转。</p>
      </div>

      <ul className="vendor-list">
        {VENDORS.map((vendor) => (
          <li key={vendor.name} className="vendor-item">
            <div className="vendor-item__head">
              <span className="vendor-item__name">{vendor.name}</span>
              <span className="vendor-item__badge">{vendor.region}</span>
            </div>
            <span className="vendor-item__lines">{vendor.lines}</span>
            <div className="vendor-item__foot">
              <span className="vendor-item__text">示例条目，不是真实服务。</span>
              <button type="button" className="btn btn--ghost vendor-item__soon" disabled>
                即将支持
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="vendor-page__foot">
        <p>本页只做展示：不能购买、不能跳转、不能加入配置。</p>
        <p>更多供应商即将支持。</p>
      </div>
    </div>
  );
}
