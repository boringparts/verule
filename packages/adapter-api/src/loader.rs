use std::{
    any::Any,
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    slice,
};

use libloading::Library;

use crate::{
    ADAPTER_ABI_VERSION, AdapterError, AdapterManifest, HostAccess, HostValue, NativeAdapterOutput,
    NativeFactRequest, NodeOperation,
    ffi::{
        self, FfiHostApi, FfiLocation, FfiManifestSlice, FfiNodeList, FfiReply, FfiRequest,
        FfiSlice, REPLY_DECLARATION, REPLY_ERROR, REPLY_KIND, REPLY_LOCATION, REPLY_NODE,
        REPLY_NODES, REPLY_NONE, REPLY_TEXT,
    },
};

type ManifestEntry = unsafe extern "C" fn() -> FfiManifestSlice;
type AdapterEntry = unsafe extern "C" fn(*const FfiHostApi, *const FfiRequest) -> i32;

/// One loaded adapter library and its validated provider manifest.
pub struct NativeLibrary {
    _library: Library,
    entry: AdapterEntry,
    package_name: String,
    path: PathBuf,
    manifest: AdapterManifest,
}

impl NativeLibrary {
    /// Loads a native adapter, validates its ABI manifest, and retains its library handle.
    pub fn load(
        package_name: impl Into<String>,
        path: impl AsRef<Path>,
    ) -> Result<Self, AdapterError> {
        let package_name = package_name.into();
        let path = path.as_ref().to_path_buf();
        let library = unsafe { Library::new(&path) }.map_err(|error| AdapterError::Load {
            package_name: package_name.clone(),
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        let manifest_fn: ManifestEntry = unsafe {
            *library
                .get::<ManifestEntry>(ffi::MANIFEST_SYMBOL)
                .map_err(|_| AdapterError::MissingSymbol {
                    package_name: package_name.clone(),
                    symbol: "verule_adapter_manifest_v1".to_string(),
                })?
        };
        let manifest_slice = unsafe { manifest_fn() };
        let manifest_bytes =
            unsafe { read_bytes(manifest_slice.bytes) }.map_err(|message| AdapterError::Load {
                package_name: package_name.clone(),
                path: path.display().to_string(),
                message,
            })?;
        let manifest =
            serde_json::from_slice::<AdapterManifest>(manifest_bytes).map_err(|error| {
                AdapterError::Load {
                    package_name: package_name.clone(),
                    path: path.display().to_string(),
                    message: format!("adapter manifest is invalid JSON: {error}"),
                }
            })?;
        manifest.validate().map_err(|error| AdapterError::Load {
            package_name: package_name.clone(),
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        let entry: AdapterEntry = unsafe {
            *library
                .get::<AdapterEntry>(ffi::ENTRY_SYMBOL)
                .map_err(|_| AdapterError::MissingSymbol {
                    package_name: package_name.clone(),
                    symbol: "verule_adapter_v1".to_string(),
                })?
        };
        Ok(Self {
            _library: library,
            entry,
            package_name,
            path,
            manifest,
        })
    }

    /// The manifest validated before the extraction entrypoint was resolved.
    #[must_use]
    pub const fn manifest(&self) -> &AdapterManifest {
        &self.manifest
    }

    /// Package name used when loading this library.
    #[must_use]
    pub fn package_name(&self) -> &str {
        &self.package_name
    }

    /// Resolved shared-library path used by the engine.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs the adapter against one active engine snapshot.
    pub fn extract(
        &self,
        request: &NativeFactRequest<'_>,
        host: &mut dyn HostAccess,
    ) -> Result<NativeAdapterOutput, AdapterError> {
        if !self
            .manifest
            .fact_type_ids
            .iter()
            .any(|id| id == request.fact_type_id)
        {
            return Err(AdapterError::UnsupportedFactType {
                adapter_id: self.manifest.id.clone(),
                fact_type_id: request.fact_type_id.to_string(),
            });
        }

        let condition = request
            .condition
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| AdapterError::InvalidOutput {
                message: format!("failed to serialize request condition: {error}"),
            })?
            .unwrap_or_default();
        let wire_request = FfiRequest {
            fact_type_id: FfiSlice::from_bytes(request.fact_type_id.as_bytes()),
            provider_id: FfiSlice::from_bytes(request.provider_id.as_bytes()),
            project_id: FfiSlice::from_bytes(request.project_id.as_bytes()),
            condition: FfiSlice::from_bytes(&condition),
            calls: FfiNodeList {
                data: request.calls.as_ptr(),
                len: request.calls.len(),
            },
            variables: FfiNodeList {
                data: request.variables.as_ptr(),
                len: request.variables.len(),
            },
            targets: FfiNodeList {
                data: request.targets.map_or(std::ptr::null(), <[u64]>::as_ptr),
                len: request.targets.map_or(0, <[u64]>::len),
            },
            has_targets: request.targets.is_some(),
        };
        let mut invocation = InvocationHost::new(host);
        let api = FfiHostApi {
            abi_version: ADAPTER_ABI_VERSION,
            context: std::ptr::from_mut(&mut invocation).cast::<c_void>(),
            read_node: Some(read_node_callback),
            read_additional_input: Some(read_additional_input_callback),
            register_additional_input: Some(register_additional_input_callback),
            finish: Some(finish_callback),
            fail: Some(fail_callback),
        };
        let status = unsafe { (self.entry)(&raw const api, &raw const wire_request) };
        if status != 0 {
            return Err(AdapterError::Plugin {
                message: invocation
                    .error
                    .unwrap_or_else(|| format!("entrypoint returned status {status}")),
            });
        }
        let output = invocation
            .output
            .ok_or_else(|| AdapterError::InvalidOutput {
                message: "adapter returned without submitting a result".to_string(),
            })?;
        serde_json::from_slice(&output).map_err(|error| AdapterError::InvalidOutput {
            message: error.to_string(),
        })
    }
}

struct InvocationHost<'a> {
    host: &'a mut dyn HostAccess,
    last_bytes: Vec<u8>,
    last_nodes: Vec<u64>,
    output: Option<Vec<u8>>,
    error: Option<String>,
}

impl<'a> InvocationHost<'a> {
    fn new(host: &'a mut dyn HostAccess) -> Self {
        Self {
            host,
            last_bytes: Vec::new(),
            last_nodes: Vec::new(),
            output: None,
            error: None,
        }
    }

    fn reply(&mut self, value: HostValue) -> Result<FfiReply, String> {
        let mut reply = FfiReply {
            tag: REPLY_NONE,
            flags: 0,
            handle: 0,
            nodes: FfiNodeList {
                data: std::ptr::null(),
                len: 0,
            },
            bytes: FfiSlice::empty(),
            location: FfiLocation {
                file: FfiSlice::empty(),
                line: 0,
                column: 0,
                end_line: 0,
                end_column: 0,
                start: 0,
                end: 0,
            },
        };
        match value {
            HostValue::None => {}
            HostValue::Node(node) => {
                reply.tag = REPLY_NODE;
                if let Some(id) = node {
                    reply.flags = 1;
                    reply.handle = id;
                }
            }
            HostValue::Nodes(nodes) => {
                self.last_nodes = nodes;
                reply.tag = REPLY_NODES;
                reply.nodes = FfiNodeList {
                    data: self.last_nodes.as_ptr(),
                    len: self.last_nodes.len(),
                };
            }
            HostValue::Text(text) => {
                reply.tag = REPLY_TEXT;
                if let Some(text) = text {
                    self.last_bytes = text.into_bytes();
                    reply.flags = 1;
                    reply.bytes = FfiSlice::from_bytes(&self.last_bytes);
                }
            }
            HostValue::Kind(kind) => {
                reply.tag = REPLY_KIND;
                reply.handle = u64::from(kind as u32);
            }
            HostValue::Location(location) => {
                reply.tag = REPLY_LOCATION;
                if let Some(location) = location {
                    self.last_bytes = location.file.into_bytes();
                    reply.flags = 1;
                    reply.location.file = FfiSlice::from_bytes(&self.last_bytes);
                    reply.location.line = location.line;
                    reply.location.column = location.column;
                    reply.location.end_line = location.end_line;
                    reply.location.end_column = location.end_column;
                    reply.location.start = location.start;
                    reply.location.end = location.end;
                }
            }
            HostValue::Declaration(declaration) => {
                reply.tag = REPLY_DECLARATION;
                if let Some(declaration) = declaration {
                    self.last_bytes =
                        serde_json::to_vec(&declaration).map_err(|error| error.to_string())?;
                    reply.flags = 1;
                    reply.bytes = FfiSlice::from_bytes(&self.last_bytes);
                }
            }
        }
        Ok(reply)
    }

    fn error_reply(&mut self, message: String) -> FfiReply {
        self.last_bytes = message.into_bytes();
        FfiReply {
            tag: REPLY_ERROR,
            flags: 0,
            handle: 0,
            nodes: FfiNodeList {
                data: std::ptr::null(),
                len: 0,
            },
            bytes: FfiSlice::from_bytes(&self.last_bytes),
            location: FfiLocation {
                file: FfiSlice::empty(),
                line: 0,
                column: 0,
                end_line: 0,
                end_column: 0,
                start: 0,
                end: 0,
            },
        }
    }
}

#[allow(unsafe_code)]
unsafe extern "C" fn read_node_callback(
    context: *mut c_void,
    node_id: u64,
    operation: u32,
) -> FfiReply {
    let Some(invocation) = (unsafe { context.cast::<InvocationHost<'_>>().as_mut() }) else {
        return FfiReply {
            tag: REPLY_ERROR,
            flags: 0,
            handle: 0,
            nodes: FfiNodeList {
                data: std::ptr::null(),
                len: 0,
            },
            bytes: FfiSlice::empty(),
            location: FfiLocation {
                file: FfiSlice::empty(),
                line: 0,
                column: 0,
                end_line: 0,
                end_column: 0,
                start: 0,
                end: 0,
            },
        };
    };
    let operation = match NodeOperation::try_from(operation) {
        Ok(operation) => operation,
        Err(error) => return invocation.error_reply(error.to_string()),
    };
    let read = catch_unwind(AssertUnwindSafe(|| {
        invocation.host.read_node(node_id, operation)
    }));
    match read {
        Ok(Ok(value)) => match invocation.reply(value) {
            Ok(reply) => reply,
            Err(message) => invocation.error_reply(message),
        },
        Ok(Err(message)) => invocation.error_reply(message),
        Err(panic) => invocation.error_reply(panic_message(panic.as_ref())),
    }
}

#[allow(unsafe_code)]
unsafe extern "C" fn read_additional_input_callback(
    context: *mut c_void,
    path: FfiSlice,
) -> FfiReply {
    let Some(invocation) = (unsafe { context.cast::<InvocationHost<'_>>().as_mut() }) else {
        return FfiReply {
            tag: REPLY_ERROR,
            flags: 0,
            handle: 0,
            nodes: FfiNodeList {
                data: std::ptr::null(),
                len: 0,
            },
            bytes: FfiSlice::empty(),
            location: FfiLocation {
                file: FfiSlice::empty(),
                line: 0,
                column: 0,
                end_line: 0,
                end_column: 0,
                start: 0,
                end: 0,
            },
        };
    };
    let path = match unsafe { read_string(path) } {
        Ok(path) => path,
        Err(message) => return invocation.error_reply(message),
    };
    let read = catch_unwind(AssertUnwindSafe(|| {
        invocation.host.read_additional_input(&path)
    }));
    match read {
        Ok(Ok(input_text)) => match invocation.reply(HostValue::Text(Some(input_text))) {
            Ok(reply) => reply,
            Err(message) => invocation.error_reply(message),
        },
        Ok(Err(message)) => invocation.error_reply(message),
        Err(panic) => invocation.error_reply(panic_message(panic.as_ref())),
    }
}

#[allow(unsafe_code)]
unsafe extern "C" fn register_additional_input_callback(
    context: *mut c_void,
    path: FfiSlice,
) -> i32 {
    let Some(invocation) = (unsafe { context.cast::<InvocationHost<'_>>().as_mut() }) else {
        return 1;
    };
    let path = match unsafe { read_string(path) } {
        Ok(path) => path,
        Err(message) => {
            invocation.error = Some(message);
            return 1;
        }
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        invocation.host.register_additional_input(&path)
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(message)) => {
            invocation.error = Some(message);
            1
        }
        Err(panic) => {
            invocation.error = Some(panic_message(panic.as_ref()));
            1
        }
    }
}

#[allow(unsafe_code)]
unsafe extern "C" fn finish_callback(context: *mut c_void, output: FfiSlice) {
    let Some(invocation) = (unsafe { context.cast::<InvocationHost<'_>>().as_mut() }) else {
        return;
    };
    match unsafe { read_bytes(output) } {
        Ok(bytes) => invocation.output = Some(bytes.to_vec()),
        Err(message) => invocation.error = Some(message),
    }
}

#[allow(unsafe_code)]
unsafe extern "C" fn fail_callback(context: *mut c_void, message: FfiSlice) {
    let Some(invocation) = (unsafe { context.cast::<InvocationHost<'_>>().as_mut() }) else {
        return;
    };
    invocation.error = Some(match unsafe { read_string(message) } {
        Ok(message) | Err(message) => message,
    });
}

#[allow(unsafe_code)]
unsafe fn read_bytes<'a>(bytes: FfiSlice) -> Result<&'a [u8], String> {
    if bytes.len == 0 {
        return Ok(&[]);
    }
    if bytes.data.is_null() {
        return Err("adapter returned a null byte pointer with nonzero length".to_string());
    }
    Ok(unsafe { slice::from_raw_parts(bytes.data, bytes.len) })
}

#[allow(unsafe_code)]
unsafe fn read_string(bytes: FfiSlice) -> Result<String, String> {
    String::from_utf8(unsafe { read_bytes(bytes) }?.to_vec())
        .map_err(|error| format!("adapter passed invalid UTF-8: {error}"))
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "host callback panicked with a non-string payload".to_string()
}
