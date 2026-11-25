import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "./brand";
import logo from "./assets/logo.png";

type AppInfo = {
  name: string;
  version: string;
};

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  return (
    <main className="shell">
      <section className="card">
        <img className="logo" src={logo} alt="" width={72} height={72} />
        <h1>{PRODUCT_NAME}</h1>
        <p className="tagline">{PRODUCT_TAGLINE}</p>
        <p className="note">
          骨架已就绪。订阅导入、配置装配与连接能力由后续阶段接入。
        </p>
        <p className="meta">{info ? `v${info.version}` : "正在读取版本…"}</p>
      </section>
    </main>
  );
}
