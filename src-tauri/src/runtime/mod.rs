pub mod archive;
pub mod error;
pub mod fsutil;
pub mod health;
pub mod install;
pub mod manager;
pub mod manifest;
pub mod process;
pub mod signature;
pub mod updates;

pub use error::{RuntimeError, RuntimeResult};
pub use health::{
    ClashApi, DataPlaneProbe, DirectIpProbe, VersionInfo, DEFAULT_DIRECT_IP_PROBE,
};
pub use install::{
    Installer, InstalledRuntime, RuntimeStateFile, BINARY_NAME, SOURCE_BUNDLED, SOURCE_INSTALLED,
};
#[cfg(feature = "runtime-selftest")]
pub use install::{InstallProgress, ProgressFn};
pub use manager::{
    default_app_data_dir, prepare_app_data_dir, runtime_event_to_emit, HealthSnapshot,
    PortFallback, PortFallbackReason, RuntimeConfig, RuntimeEvent,
    RuntimeEventKind, RuntimeHealthChangedPayload, RuntimeManager, RuntimeMode, RuntimeState,
    RuntimeStateChangedPayload, RuntimeStatus, RuntimeErrorInfo, StartPlan, TunSnapshotInput,
    CONTRACT_VERSION, DEFAULT_DATA_PLANE_PROBE, EVENT_CONTRACT_VERSION,
};
pub use manifest::{current_release, Artifact, ArchiveFormat, Release, RuntimeManifest};
