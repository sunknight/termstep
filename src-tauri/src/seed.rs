//! 对偶 src/main/seed.ts。首次运行（toolsDir 空）建一个默认 git 工具。

use std::path::Path;

pub async fn seed_default_tool(tools_dir: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(tools_dir).await?;
    let git_dir = tools_dir.join(crate::tool_io::new_tool_id());
    tokio::fs::create_dir_all(&git_dir).await?;
    tokio::fs::write(
        git_dir.join("tool.json"),
        "{\n  \"name\": \"Git\",\n  \"icon\": \"🌿\",\n  \"order\": 0\n}\n",
    )
    .await?;
    let help = "# Git\n\n常用命令：\n\n```buttons\n// 查看状态\ngit status # 查看状态\ngit log --oneline -20\n\n// 改完再提交\ngit commit -m \"\" // edit\ngit push ### label=推送; tag=常用\n```\n\n带参数：\n\n```buttons-json\n[\n  {\n    \"label\": \"提交（填信息）\",\n    \"command\": \"git commit -m {{message}}\",\n    \"edit\": true,\n    \"params\": [\n      { \"name\": \"message\", \"hint\": \"提交信息\", \"required\": true }\n    ]\n  }\n]\n```\n";
    tokio::fs::write(git_dir.join("help.md"), help).await?;
    Ok(())
}
