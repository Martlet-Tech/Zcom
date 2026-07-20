use crc::{Crc, Algorithm};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ChecksumResult {
    pub value: String,
    pub hex: String,
}

const CRC16_MODBUS: Crc<u16> = Crc::<u16>::new(&Algorithm {
    width: 16,
    poly: 0x8005,
    init: 0xFFFF,
    refin: true,
    refout: true,
    xorout: 0x0000,
    check: 0x4B37,
    residue: 0x0000,
});

const CRC32: Crc<u32> = Crc::<u32>::new(&Algorithm {
    width: 32,
    poly: 0x04C11DB7,
    init: 0xFFFFFFFF,
    refin: true,
    refout: true,
    xorout: 0xFFFFFFFF,
    check: 0xCBF43926,
    residue: 0xDEBB20E3,
});

pub fn calc_checksum(data: &[u8], algo: &str) -> ChecksumResult {
    match algo {
        "crc16" => {
            let digest = CRC16_MODBUS.checksum(data);
            ChecksumResult {
                value: digest.to_string(),
                hex: format!("{:04X}", digest),
            }
        }
        "crc32" => {
            let digest = CRC32.checksum(data);
            ChecksumResult {
                value: digest.to_string(),
                hex: format!("{:08X}", digest),
            }
        }
        "add8" => {
            let sum: u8 = data.iter().fold(0u8, |a, b| a.wrapping_add(*b));
            ChecksumResult {
                value: sum.to_string(),
                hex: format!("{:02X}", sum),
            }
        }
        "xor8" => {
            let xor = data.iter().fold(0u8, |a, b| a ^ b);
            ChecksumResult {
                value: xor.to_string(),
                hex: format!("{:02X}", xor),
            }
        }
        _ => ChecksumResult {
            value: "0".into(),
            hex: "00".into(),
        },
    }
}

pub fn apply_checksum(data: &[u8], algo: &str, position: i32) -> Vec<u8> {
    let result = calc_checksum(data, algo);
    let check_bytes = hex_to_bytes(&result.hex);
    let pos = if position >= 0 {
        position as usize
    } else {
        let from_end = (-position) as usize;
        if from_end > data.len() { data.len() } else { data.len() - from_end }
    };
    let pos = pos.min(data.len());
    let mut out = Vec::with_capacity(data.len() + check_bytes.len());
    out.extend_from_slice(&data[..pos]);
    out.extend_from_slice(&check_bytes);
    out.extend_from_slice(&data[pos..]);
    out
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    let s = s.trim();
    if s.len() < 2 { return vec![]; }
    let bytes: Vec<u8> = (0..s.len()).step_by(2)
        .filter_map(|i| u8::from_str_radix(&s[i..i+2], 16).ok())
        .collect();
    bytes
}
