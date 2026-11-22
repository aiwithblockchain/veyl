//! In-memory `Host` used by unit tests. Not compiled into the binary.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::host::{CmdOutput, Host};

#[derive(Default)]
pub struct FakeHost {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
    commands: Mutex<Vec<(String, Vec<String>)>>,
    outputs: Mutex<HashMap<String, CmdOutput>>,
    queues: Mutex<HashMap<String, VecDeque<CmdOutput>>>,
    download: Mutex<Vec<u8>>,
    hash: Mutex<String>,
    connects: Mutex<Vec<SocketAddr>>,
}

impl FakeHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_file(&self, path: &Path, bytes: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), bytes);
    }

    pub fn set_download(&self, bytes: Vec<u8>) {
        *self.download.lock().unwrap() = bytes;
    }

    pub fn set_hash(&self, hash: &str) {
        *self.hash.lock().unwrap() = hash.to_string();
    }

    pub fn set_command_output(&self, program: &str, status: i32, stdout: &str, stderr: &str) {
        self.outputs.lock().unwrap().insert(
            program.to_string(),
            CmdOutput {
                status: Some(status),
                stdout: stdout.to_string(),
                stderr: stderr.to_string(),
            },
        );
    }

    /// Responses consumed in order for `program`; falls back to
    /// `set_command_output` once the queue is empty.
    pub fn queue_command_outputs(&self, program: &str, outputs: &[(i32, &str, &str)]) {
        let mut queues = self.queues.lock().unwrap();
        let queue = queues.entry(program.to_string()).or_default();
        for (status, stdout, stderr) in outputs {
            queue.push_back(CmdOutput {
                status: Some(*status),
                stdout: (*stdout).to_string(),
                stderr: (*stderr).to_string(),
            });
        }
    }

    pub fn commands(&self) -> Vec<(String, Vec<String>)> {
        self.commands.lock().unwrap().clone()
    }

    pub fn file(&self, path: &Path) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(path).cloned()
    }
}

#[async_trait]
impl Host for FakeHost {
    async fn run(&self, program: &str, args: &[String]) -> Result<CmdOutput> {
        self.commands
            .lock()
            .unwrap()
            .push((program.to_string(), args.to_vec()));
        let queued = {
            let mut queues = self.queues.lock().unwrap();
            queues.get_mut(program).and_then(|q| q.pop_front())
        };
        if let Some(output) = queued {
            return Ok(output);
        }
        Ok(self
            .outputs
            .lock()
            .unwrap()
            .get(program)
            .cloned()
            .unwrap_or(CmdOutput {
                status: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            }))
    }

    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }

    async fn write(&self, path: &Path, bytes: &[u8], _mode: u32) -> Result<()> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), bytes.to_vec());
        Ok(())
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        let bytes = self.files.lock().unwrap().remove(from);
        match bytes {
            Some(bytes) => {
                self.files
                    .lock()
                    .unwrap()
                    .insert(to.to_path_buf(), bytes);
                Ok(())
            }
            None => bail!("rename: {} does not exist", from.display()),
        }
    }

    async fn remove(&self, path: &Path) -> Result<()> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn create_dir_all(&self, _path: &Path) -> Result<()> {
        Ok(())
    }

    async fn is_file(&self, path: &Path) -> Result<bool> {
        Ok(self.files.lock().unwrap().contains_key(path))
    }

    async fn connect(&self, addr: SocketAddr, _timeout: Duration) -> Result<()> {
        self.connects.lock().unwrap().push(addr);
        Ok(())
    }

    async fn download(&self, _url: &str, dest: &Path) -> Result<()> {
        let bytes = self.download.lock().unwrap().clone();
        self.files
            .lock()
            .unwrap()
            .insert(dest.to_path_buf(), bytes);
        Ok(())
    }

    async fn sha256_file(&self, path: &Path) -> Result<String> {
        if !self.files.lock().unwrap().contains_key(path) {
            bail!("sha256: {} does not exist", path.display());
        }
        Ok(self.hash.lock().unwrap().clone())
    }
}
