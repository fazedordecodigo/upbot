use tauri::Manager;

#[tauri::command]
pub fn set_approval_badge(app: tauri::AppHandle, count: u32) -> Result<(), &'static str> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    #[cfg(target_os = "windows")]
    let result = window.set_overlay_icon((count > 0).then(|| overlay(count)));
    #[cfg(not(target_os = "windows"))]
    let result = window.set_badge_count((count > 0).then_some(i64::from(count)));
    result.map_err(|_| "badge_update_failed")
}

#[cfg(any(target_os = "windows", test))]
fn label(count: u32) -> String {
    if count > 9 {
        "9+".into()
    } else {
        count.to_string()
    }
}

#[cfg(target_os = "windows")]
fn overlay(count: u32) -> tauri::image::Image<'static> {
    const GLYPHS: [[u8; 5]; 11] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
        [0, 2, 7, 2, 0],
    ];
    let mut rgba = vec![0; 32 * 32 * 4];
    for y in 0..32i32 {
        for x in 0..32i32 {
            if (x * 2 - 31).pow(2) + (y * 2 - 31).pow(2) <= 31 * 31 {
                let offset = (y as usize * 32 + x as usize) * 4;
                rgba[offset..offset + 4].copy_from_slice(&[210, 38, 48, 255]);
            }
        }
    }
    let text = label(count);
    let start = (32 - (text.len() * 8 - 2)) / 2;
    for (index, byte) in text.bytes().enumerate() {
        let glyph = if byte == b'+' {
            10
        } else {
            (byte - b'0') as usize
        };
        for (y, row) in GLYPHS[glyph].iter().enumerate() {
            for x in 0..3 {
                if row & (1 << (2 - x)) == 0 {
                    continue;
                }
                for dy in 0..2 {
                    for dx in 0..2 {
                        let offset = ((11 + y * 2 + dy) * 32 + start + index * 8 + x * 2 + dx) * 4;
                        rgba[offset..offset + 4].copy_from_slice(&[255; 4]);
                    }
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, 32, 32)
}

#[cfg(test)]
mod tests {
    #[test]
    fn overlay_labels() {
        for count in 1..=9 {
            assert_eq!(super::label(count), count.to_string());
        }
        assert_eq!(super::label(10), "9+");
        assert_eq!(super::label(u32::MAX), "9+");
    }
}
