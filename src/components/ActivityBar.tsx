import logo from "../assets/logo.png";
import { PRODUCT_NAME } from "../brand";

/** 最左侧窄条。本期只有「客户端」一项，没做的入口不显示。 */
export function ActivityBar() {
  return (
    <nav className="activity-bar" aria-label="主导航">
      <div className="activity-bar__brand">
        <img className="activity-bar__mark" src={logo} alt={PRODUCT_NAME} />
      </div>
      <button
        type="button"
        className="activity-bar__item is-active"
        title="客户端"
        aria-label="客户端"
        aria-current="page"
      >
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
          <rect
            x="2.75"
            y="3.75"
            width="14.5"
            height="10"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M7 17h6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </nav>
  );
}
