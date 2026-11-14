//! 控制面 HTTP 传输：带 Bearer 的请求、401 单次刷新重试、错误信封。
//!
//! 业务层（`servers` / `credentials`）只关心路径与 JSON，不重复处理令牌。

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use super::auth;
use super::error::{self, CpError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

pub struct ControlPlane {
    base_url: String,
    http: reqwest::Client,
}

impl ControlPlane {
    pub fn new() -> Result<Self, CpError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| CpError::internal(format!("创建控制面客户端失败：{error}")))?;
        Ok(Self {
            base_url: crate::control_plane::env::current().base_url,
            http,
        })
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CpError> {
        let token = auth::ensure_access(&self.base_url, &self.http, None).await?;
        let (status, text) = self
            .send(method.clone(), path, body, idempotency_key, &token)
            .await?;
        if status != 401 {
            return decode(status, &text);
        }

        // access 过期：刷新（或重新注册）后只重试一次。幂等键原样复用。
        let refreshed = auth::ensure_access(&self.base_url, &self.http, Some(&token)).await?;
        let (status, text) = self
            .send(method, path, body, idempotency_key, &refreshed)
            .await?;
        decode(status, &text)
    }

    pub async fn get(&self, path: &str) -> Result<Value, CpError> {
        self.request(Method::GET, path, None, None).await
    }

    pub async fn post(
        &self,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CpError> {
        self.request(Method::POST, path, body, idempotency_key).await
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
        token: &str,
    ) -> Result<(u16, String), CpError> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| CpError::network(error.is_timeout()))?;
        if let Some(length) = response.content_length() {
            if length as usize > MAX_RESPONSE_BYTES {
                return Err(CpError::invalid_response("控制面响应过大"));
            }
        }
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| CpError::network(error.is_timeout()))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CpError::invalid_response("控制面响应过大"));
        }
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| CpError::invalid_response("控制面响应不是 UTF-8"))?;
        Ok((status, text))
    }
}

fn decode(status: u16, text: &str) -> Result<Value, CpError> {
    if !(200..=299).contains(&status) {
        return Err(error::from_response(status, text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text)
        .map_err(|_| CpError::invalid_response("控制面响应格式不正确"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_204_is_an_empty_success() {
        // `my_server_destroy` 的 HTTP 响应是 204；命令层把它映射成
        // `state: "destroying"` 的 MyServer，前端不用特判空响应。
        assert_eq!(decode(204, "").unwrap(), Value::Null);
        assert_eq!(decode(204, "  ").unwrap(), Value::Null);
        assert!(decode(500, "").is_err());
    }
}
