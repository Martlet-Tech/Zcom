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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc16_modbus_check_vector() {
        let r = calc_checksum(b"123456789", ChecksumAlgo::Crc16);
        assert_eq!(r.hex, "4B37");
    }

    #[test]
    fn crc32_check_vector() {
        let r = calc_checksum(b"123456789", ChecksumAlgo::Crc32);
        assert_eq!(r.hex, "CBF43926");
    }

    #[test]
    fn add8_sums_with_wraparound() {
        let r = calc_checksum(&[0x01, 0x02, 0x03], ChecksumAlgo::Add8);
        assert_eq!(r.hex, "06");
        let wrap = calc_checksum(&[0xFF, 0x01], ChecksumAlgo::Add8);
        assert_eq!(wrap.hex, "00");
    }

    #[test]
    fn xor8_xors_bytes() {
        let r = calc_checksum(&[0x11, 0x22], ChecksumAlgo::Xor8);
        assert_eq!(r.hex, "33");
    }

    #[test]
    fn apply_inserts_before_first_byte() {
        let out = apply_checksum(&[0x01, 0x02, 0x03], ChecksumAlgo::Add8, 0, false);
        assert_eq!(out, vec![0x06, 0x01, 0x02, 0x03]);
    }

    #[test]
    fn apply_inserts_after_last_byte_with_negative_pos() {
        let out = apply_checksum(&[0x01, 0x02, 0x03], ChecksumAlgo::Add8, -1, false);
        assert_eq!(out, vec![0x01, 0x02, 0x06, 0x03]);
    }

    #[test]
    fn apply_lsb_reverses_two_byte_checksum() {
        let out = apply_checksum(&[0x01, 0x02], ChecksumAlgo::Crc16, 0, true);
        let c = calc_checksum(&[0x01, 0x02], ChecksumAlgo::Crc16);
        let hi = u8::from_str_radix(&c.hex[0..2], 16).unwrap();
        let lo = u8::from_str_radix(&c.hex[2..4], 16).unwrap();
        assert_eq!(out, vec![lo, hi, 0x01, 0x02]);
    }

    #[test]
    fn unknown_algo_parsing_fails() {
        assert!("bogus".parse::<ChecksumAlgo>().is_err());
        assert!("crc16".parse::<ChecksumAlgo>().is_ok());
    }
}
