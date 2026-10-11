use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// 一条已建立的连接会话（仅记录状态，查询仍按需取用驱动）
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SessionInfo {
    pub db_type: String,
    /// 建立时驱动返回的提示（如「连接成功」）
    pub detail: String,
    /// 建立时间（毫秒时间戳）
    pub since_ms: u64,
}

/// 连接会话表：conn.id -> 会话信息；「连接 / 断开」只在内存内维护
#[derive(Default)]
pub struct SessionStore(Mutex<HashMap<String, SessionInfo>>);

impl SessionStore {
    pub fn mark(&self, id: &str, info: SessionInfo) {
        let mut m = self.0.lock().unwrap();
        m.insert(id.to_string(), info);
    }

    pub fn remove(&self, id: &str) {
        let mut m = self.0.lock().unwrap();
        m.remove(id);
    }

    pub fn snapshot(&self) -> HashMap<String, SessionInfo> {
        self.0.lock().unwrap().clone()
    }
}
