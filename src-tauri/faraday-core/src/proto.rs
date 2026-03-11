/// Binary IPC protocol — must stay in sync with src/protocol.ts.
///
/// Wire format: [4: payload_len (u32 LE)][payload...]
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use std::io::{self, Read, Write as IoWrite};

// ── Message types ────────────────────────────────────────────────────

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgType {
    Auth = 0x01,
    Request = 0x02,
    Response = 0x82,
    Error = 0x83,
    Event = 0x84,
}

impl TryFrom<u8> for MsgType {
    type Error = ();
    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0x01 => Ok(Self::Auth),
            0x02 => Ok(Self::Request),
            0x82 => Ok(Self::Response),
            0x83 => Ok(Self::Error),
            0x84 => Ok(Self::Event),
            _ => Err(()),
        }
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Ping = 0x01,
    Entries = 0x02,
    Stat = 0x03,
    Exists = 0x04,
    Open = 0x05,
    Read = 0x06,
    Close = 0x07,
    Watch = 0x08,
    Unwatch = 0x09,
}

impl TryFrom<u8> for Method {
    type Error = ();
    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0x01 => Ok(Self::Ping),
            0x02 => Ok(Self::Entries),
            0x03 => Ok(Self::Stat),
            0x04 => Ok(Self::Exists),
            0x05 => Ok(Self::Open),
            0x06 => Ok(Self::Read),
            0x07 => Ok(Self::Close),
            0x08 => Ok(Self::Watch),
            0x09 => Ok(Self::Unwatch),
            _ => Err(()),
        }
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventType {
    Appeared = 0x00,
    Disappeared = 0x01,
    Modified = 0x02,
    Errored = 0x03,
    Unknown = 0x04,
}

impl EventType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "appeared" => Self::Appeared,
            "disappeared" => Self::Disappeared,
            "modified" => Self::Modified,
            "errored" => Self::Errored,
            _ => Self::Unknown,
        }
    }
}

// ── Reader — zero-copy decode from a message payload ─────────────────

#[derive(Debug)]
pub struct ProtoError;

impl std::fmt::Display for ProtoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "protocol decode error: unexpected end of buffer")
    }
}

impl std::error::Error for ProtoError {}

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn remaining(&self) -> &'a [u8] {
        &self.data[self.pos..]
    }

    pub fn u8(&mut self) -> Result<u8, ProtoError> {
        if self.pos >= self.data.len() {
            return Err(ProtoError);
        }
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn u16(&mut self) -> Result<u16, ProtoError> {
        if self.pos + 2 > self.data.len() {
            return Err(ProtoError);
        }
        let v = (&self.data[self.pos..]).read_u16::<LittleEndian>().unwrap();
        self.pos += 2;
        Ok(v)
    }

    pub fn u32(&mut self) -> Result<u32, ProtoError> {
        if self.pos + 4 > self.data.len() {
            return Err(ProtoError);
        }
        let v = (&self.data[self.pos..]).read_u32::<LittleEndian>().unwrap();
        self.pos += 4;
        Ok(v)
    }

    pub fn f64(&mut self) -> Result<f64, ProtoError> {
        if self.pos + 8 > self.data.len() {
            return Err(ProtoError);
        }
        let v = (&self.data[self.pos..]).read_f64::<LittleEndian>().unwrap();
        self.pos += 8;
        Ok(v)
    }

    pub fn str(&mut self) -> Result<&'a str, ProtoError> {
        let len = self.u16()? as usize;
        if self.pos + len > self.data.len() {
            return Err(ProtoError);
        }
        let s = std::str::from_utf8(&self.data[self.pos..self.pos + len]).map_err(|_| ProtoError)?;
        self.pos += len;
        Ok(s)
    }

    pub fn bytes(&mut self) -> Result<&'a [u8], ProtoError> {
        let len = self.u32()? as usize;
        if self.pos + len > self.data.len() {
            return Err(ProtoError);
        }
        let b = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(b)
    }
}

// ── Writer — build a message payload ─────────────────────────────────

pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(256),
        }
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.write_u16::<LittleEndian>(v).unwrap();
        self
    }

    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.write_u32::<LittleEndian>(v).unwrap();
        self
    }

    pub fn f64(&mut self, v: f64) -> &mut Self {
        self.buf.write_f64::<LittleEndian>(v).unwrap();
        self
    }

    /// Length-prefixed string: u16 LE length + UTF-8 bytes.
    pub fn str(&mut self, s: &str) -> &mut Self {
        self.u16(s.len() as u16);
        self.buf.extend_from_slice(s.as_bytes());
        self
    }

    /// Length-prefixed bytes: u32 LE length + data.
    pub fn bytes(&mut self, data: &[u8]) -> &mut Self {
        self.u32(data.len() as u32);
        self.buf.extend_from_slice(data);
        self
    }

    /// Raw bytes without length prefix.
    pub fn raw(&mut self, data: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(data);
        self
    }

    /// Overwrite a u32 at a previously-known offset (for patching counts).
    pub fn patch_u32(&mut self, offset: usize, v: u32) {
        (&mut self.buf[offset..offset + 4])
            .write_u32::<LittleEndian>(v)
            .unwrap();
    }

    /// Wrap the payload with a u32 LE length prefix for wire transmission.
    pub fn into_framed(self) -> Vec<u8> {
        let payload = self.buf;
        let mut framed = Vec::with_capacity(4 + payload.len());
        framed.write_u32::<LittleEndian>(payload.len() as u32).unwrap();
        framed.extend_from_slice(&payload);
        framed
    }
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}

// ── MsgReader — accumulates socket data and yields complete messages ──

pub struct MsgReader {
    buf: Vec<u8>,
}

impl MsgReader {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
        }
    }

    /// Read available data from a reader. Returns bytes read (0 = EOF).
    pub fn fill(&mut self, reader: &mut impl Read) -> io::Result<usize> {
        let mut tmp = [0u8; 4096];
        let n = reader.read(&mut tmp)?;
        self.buf.extend_from_slice(&tmp[..n]);
        Ok(n)
    }

    /// Append externally-read data.
    pub fn feed(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Extract the next complete message payload (without length prefix).
    pub fn next_msg(&mut self) -> Option<Vec<u8>> {
        if self.buf.len() < 4 {
            return None;
        }
        let plen = (&self.buf[..4]).read_u32::<LittleEndian>().unwrap() as usize;
        let total = 4 + plen;
        if self.buf.len() < total {
            return None;
        }
        let msg = self.buf[4..total].to_vec();
        self.buf.drain(..total);
        Some(msg)
    }
}

impl Default for MsgReader {
    fn default() -> Self {
        Self::new()
    }
}

/// Write a length-prefixed message to a writer.
pub fn write_msg(writer: &mut impl IoWrite, data: &[u8]) -> io::Result<()> {
    writer.write_u32::<LittleEndian>(data.len() as u32)?;
    if !data.is_empty() {
        writer.write_all(data)?;
    }
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_reader_roundtrip() {
        let mut w = Writer::new();
        w.u8(0x42)
            .u16(1234)
            .u32(0xDEADBEEF)
            .f64(3.14)
            .str("hello")
            .bytes(&[1, 2, 3]);

        let data = w.into_vec();
        let mut r = Reader::new(&data);
        assert_eq!(r.u8().unwrap(), 0x42);
        assert_eq!(r.u16().unwrap(), 1234);
        assert_eq!(r.u32().unwrap(), 0xDEADBEEF);
        assert!((r.f64().unwrap() - 3.14).abs() < f64::EPSILON);
        assert_eq!(r.str().unwrap(), "hello");
        assert_eq!(r.bytes().unwrap(), &[1, 2, 3]);
    }

    #[test]
    fn f64_encoding_matches_ieee754_le() {
        // Verify f64 is encoded as IEEE 754 LE (same as JS writeDoubleLE)
        let mut w = Writer::new();
        w.f64(1.0);
        let bytes = w.into_vec();
        // IEEE 754: 1.0 = 0x3FF0000000000000 in LE = [00, 00, 00, 00, 00, 00, F0, 3F]
        assert_eq!(bytes, &[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF0, 0x3F]);
    }

    #[test]
    fn msg_reader_framing() {
        let mut w = Writer::new();
        w.u8(MsgType::Response as u8).u32(42).str("ok");
        let framed = w.into_framed();

        let mut mr = MsgReader::new();
        // Feed partial data
        mr.feed(&framed[..3]);
        assert!(mr.next_msg().is_none());
        // Feed the rest
        mr.feed(&framed[3..]);
        let msg = mr.next_msg().unwrap();
        let mut r = Reader::new(&msg);
        assert_eq!(r.u8().unwrap(), MsgType::Response as u8);
        assert_eq!(r.u32().unwrap(), 42);
        assert_eq!(r.str().unwrap(), "ok");
    }

    #[test]
    fn msg_reader_multiple_messages() {
        let mut mr = MsgReader::new();

        let mut w1 = Writer::new();
        w1.u8(1);
        let msg1 = w1.into_framed();
        let mut w2 = Writer::new();
        w2.u8(2);
        let msg2 = w2.into_framed();

        let mut combined = msg1;
        combined.extend_from_slice(&msg2);
        mr.feed(&combined);

        let m1 = mr.next_msg().unwrap();
        assert_eq!(m1, &[1]);
        let m2 = mr.next_msg().unwrap();
        assert_eq!(m2, &[2]);
        assert!(mr.next_msg().is_none());
    }

    #[test]
    fn patch_u32() {
        let mut w = Writer::new();
        w.u32(0); // placeholder at offset 0
        w.str("test");
        w.patch_u32(0, 99);
        let mut r = Reader::new(w.as_slice());
        assert_eq!(r.u32().unwrap(), 99);
    }

    #[test]
    fn write_msg_framing() {
        let mut buf = Vec::new();
        write_msg(&mut buf, b"hello").unwrap();
        assert_eq!(buf.len(), 4 + 5);
        let mut r = Reader::new(&buf);
        assert_eq!(r.u32().unwrap(), 5); // payload length
    }

    // Chain-style Writer test — verifying it returns &mut Self
    #[test]
    fn writer_chaining() {
        let mut w = Writer::new();
        let w = w.u8(MsgType::Request as u8);
        let _ = w.u32(1).u8(Method::Entries as u8).str("/tmp");
        // Just verify it compiles and doesn't panic
    }
}
