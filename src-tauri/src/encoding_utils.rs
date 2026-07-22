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
