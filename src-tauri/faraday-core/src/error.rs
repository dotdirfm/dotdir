/// Filesystem error type with errno-style codes.
///
/// The `errno_str()` method returns the POSIX error code string that
/// the TypeScript layer uses for error mapping (src/fs/native.ts).

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("ENOENT")]
    NotFound,
    #[error("EACCES")]
    PermissionDenied,
    #[error("ENOTDIR")]
    NotDir,
    #[error("EISDIR")]
    IsDir,
    #[error("ENOMEM")]
    OutOfMemory,
    #[error("EEXIST")]
    AlreadyExists,
    #[error("EBADF")]
    BadFd,
    #[error("EINVAL")]
    InvalidInput,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl FsError {
    /// Return the errno-style code string (e.g. "ENOENT", "EACCES").
    /// Must match the error codes expected by src/fs/native.ts.
    pub fn errno_str(&self) -> &'static str {
        match self {
            Self::NotFound => "ENOENT",
            Self::PermissionDenied => "EACCES",
            Self::NotDir => "ENOTDIR",
            Self::IsDir => "EISDIR",
            Self::OutOfMemory => "ENOMEM",
            Self::AlreadyExists => "EEXIST",
            Self::BadFd => "EBADF",
            Self::InvalidInput => "EINVAL",
            Self::Io(e) => io_errno(e),
        }
    }

    /// Convert from std::io::Error, mapping to the specific FsError variant
    /// when a known ErrorKind is encountered.
    pub fn from_io(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound,
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            std::io::ErrorKind::AlreadyExists => Self::AlreadyExists,
            _ => Self::Io(e),
        }
    }

    /// Reconstruct from errno string code and message (used by proxy protocol).
    pub fn from_errno_str(code: &str, _message: &str) -> Self {
        match code {
            "ENOENT" => Self::NotFound,
            "EACCES" => Self::PermissionDenied,
            "ENOTDIR" => Self::NotDir,
            "EISDIR" => Self::IsDir,
            "ENOMEM" => Self::OutOfMemory,
            "EEXIST" => Self::AlreadyExists,
            "EBADF" => Self::BadFd,
            "EINVAL" => Self::InvalidInput,
            _ => Self::Io(std::io::Error::new(std::io::ErrorKind::Other, _message.to_string())),
        }
    }
}

fn io_errno(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        _ => "EIO",
    }
}
