use crc::{Crc, Algorithm};
use serde::Serialize;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ChecksumAlgo {
    Crc16,
    Crc32,
    Add8,
    Xor8,
}

impl FromStr for ChecksumAlgo {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "crc16" => Ok(Self::Crc16),
            "crc32" => Ok(Self::Crc32),
            "add8" => Ok(Self::Add8),
            "xor8" => Ok(Self::Xor8),
            _ => Err(format!("Unknown checksum algorithm: {}", s)),
        }
    }
}

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

pub fn calc_checksum(data: &[u8], algo: ChecksumAlgo) -> ChecksumResult {
    match algo {
        ChecksumAlgo::Crc16 => {
            let digest = CRC16_MODBUS.checksum(data);
            ChecksumResult {
                value: digest.to_string(),
                hex: format!("{:04X}", digest),
            }
        }
        ChecksumAlgo::Crc32 => {
            let digest = CRC32.checksum(data);
            ChecksumResult {
                value: digest.to_string(),
                hex: format!("{:08X}", digest),
            }
        }
        ChecksumAlgo::Add8 => {
            let sum: u8 = data.iter().fold(0u8, |a, b| a.wrapping_add(*b));
            ChecksumResult {
                value: sum.to_string(),
                hex: format!("{:02X}", sum),
            }
        }
        ChecksumAlgo::Xor8 => {
            let xor = data.iter().fold(0u8, |a, b| a ^ b);
            ChecksumResult {
                value: xor.to_string(),
                hex: format!("{:02X}", xor),
            }
        }
    }
}

pub fn apply_checksum(data: &[u8], algo: ChecksumAlgo, position: i32, lsb: bool) -> Vec<u8> {
    let result = calc_checksum(data, algo);
    let mut check_bytes: Vec<u8> = (0..result.hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&result.hex[i..i + 2], 16).unwrap())
        .collect();
    if lsb {
        check_bytes.reverse();
    }
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
