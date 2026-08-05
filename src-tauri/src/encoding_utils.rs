fn decode_oem_text(bytes: &[u8]) -> String {
    #[cfg(windows)]
    {
        extern "system" {
            fn GetOEMCP() -> u32;
        }
        let cp = unsafe { GetOEMCP() };
        match cp {
            936 => encoding_rs::GBK.decode(bytes).0.into_owned(),
            932 => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
            949 => encoding_rs::EUC_KR.decode(bytes).0.into_owned(),
            950 => encoding_rs::BIG5.decode(bytes).0.into_owned(),
            1250 | 1252 | 1254 | 1257 => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
            1251 => encoding_rs::WINDOWS_1251.decode(bytes).0.into_owned(),
            1253 => encoding_rs::ISO_8859_7.decode(bytes).0.into_owned(),
            1255 => encoding_rs::WINDOWS_1255.decode(bytes).0.into_owned(),
            1256 => encoding_rs::WINDOWS_1256.decode(bytes).0.into_owned(),
            1258 => encoding_rs::WINDOWS_1258.decode(bytes).0.into_owned(),
            _ => String::from_utf8_lossy(bytes).into_owned(),
        }
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Decodes console/CMD output: valid UTF-8 is used as-is, otherwise falls back
/// to the OEM code page (GBK etc.) so localized cmd errors are not lost.
pub(crate) fn decode_console_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => decode_oem_text(bytes),
    }
}

pub(crate) fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        "gbk" => {
            let (cow, _, _) = encoding_rs::GBK.encode(text);
            cow.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    }
}

pub(crate) fn parse_hex_string(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(vec![]);
    }
    let hex_chars: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if hex_chars.len() % 2 != 0 {
        return Err("Hex string must have even number of characters".into());
    }
    let bytes: Result<Vec<u8>, _> = (0..hex_chars.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex_chars[i..i + 2], 16))
        .collect();
    bytes.map_err(|e| format!("Invalid hex: {}", e))
}

pub(crate) fn get_port_description(name: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("wmic");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .args([
            "path", "Win32_SerialPort",
            "where", &format!("DeviceID='{}'", name),
            "get", "Name", "/format:value",
        ])
        .output()
        .ok()?;
    let text = decode_oem_text(&output.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(value) = line.strip_prefix("Name=") {
            let value: String = value.chars().filter(|c| !c.is_control()).collect();
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn decode_bytes(bytes: Vec<u8>, encoding: String) -> Result<String, String> {
    match encoding.as_str() {
        "gbk" => {
            let (cow, _, _) = encoding_rs::GBK.decode(&bytes);
            Ok(cow.into_owned())
        }
        _ => Ok(String::from_utf8_lossy(&bytes).into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_encode_known_bytes() {
        assert_eq!(encode_text("中文", "gbk"), vec![0xD6, 0xD0, 0xCE, 0xC4]);
        assert_eq!(encode_text("abc", "gbk"), b"abc".to_vec());
    }

    #[test]
    fn gbk_decode_roundtrip() {
        let bytes = encode_text("串口调试", "gbk");
        let (decoded, _, _) = encoding_rs::GBK.decode(&bytes);
        assert_eq!(decoded, "串口调试");
    }

    #[test]
    fn parse_hex_strips_whitespace() {
        assert_eq!(parse_hex_string("01 0A ff").unwrap(), vec![0x01, 0x0A, 0xFF]);
        let empty: Vec<u8> = Vec::new();
        assert_eq!(parse_hex_string("").unwrap(), empty);
    }

    #[test]
    fn parse_hex_rejects_odd_length() {
        assert!(parse_hex_string("0A1").is_err());
        assert!(parse_hex_string("zz").is_err());
    }
}
