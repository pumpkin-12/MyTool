// 发布版不弹控制台窗口；debug 构建保留，方便看 println! 输出
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    toolbox_lib::run()
}
