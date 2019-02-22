// 0 = false, 1 = true
function bint(x) {
    return !!parseInt(x);
}

function validateCSS(c) {
    c += "";
    if(c == "default") return "";
    if(typeof c !== "string") return "";
    if(c.length > 100) c = c.slice(0, 100);
    c = c.replace(/{/g, "");
    c = c.replace(/}/g, "");
    c = c.replace(/;/g, "");
    c = c.replace(/\r/g, "");
    c = c.replace(/\n/g, "");
    return c.slice(0, 20);
}

function validatePerms(p, max, allowNeg) {
    if(!max) max = 2;
    var num = parseInt(p, 10);
    if(isNaN(num)) return 0;
    if(num === -1 && allowNeg) return -1;
    if(num < 0) return 0;
    if(num > max) return 0;
    return num;
}

module.exports.GET = async function(req, serve, vars, params) {
    var HTML = vars.HTML;
    var user = vars.user;
    var url = vars.url;
    var path = vars.path;
    var get_third = vars.get_third;
    var db = vars.db;
    var dispage = vars.dispage;
    var world_get_or_create = vars.world_get_or_create;

    if(!user.authenticated) {
        return serve(null, null, {
            redirect: "/accounts/login/?next=" + url.parse(req.url).pathname
        })
    }

    // gets world name from /accounts/configure/{world}/
    var world_name = get_third(path, "accounts", "configure")

    var world = await world_get_or_create(world_name)
    if(!world) {
        return await dispage("404", null, req, serve, vars)
    }

    if(world.owner_id != user.id && !user.superuser) {
        return serve("Access denied", 403)
    }

    world_name = world.name;

    var members = await db.all("SELECT * FROM whitelist WHERE world_id=?", world.id)
    var member_list = []; // processed list of members
    for(var i = 0; i < members.length; i++) {
        var username = await db.get("SELECT username FROM auth_user WHERE id=?", members[i].user_id)
        member_list.push({
            member_name: username.username
        });
    }

    var properties = JSON.parse(world.properties);

    // if empty, make sure server knows it's empty
    // ([] is considered to not be empty through boolean conversion)
    if(member_list.length === 0) member_list = null;

    var owner_name = ""

    if(world.owner_id) {
        owner_name = (await db.get("SELECT username FROM auth_user WHERE id=?", [world.owner_id])).username
    }

    var color = world.custom_color || "default";
    var cursor_color = world.custom_cursor || "default";
    var cursor_guest_color = world.custom_guest_cursor || "default";
    var bg = world.custom_bg || "default";
    var owner_color = world.custom_tile_owner || "default";
    var member_color = world.custom_tile_member || "default";
    var menu_color = properties.custom_menu_color || "default";

    var data = {
        user,

        world: world_name,
        csrftoken: user.csrftoken,
        members: member_list,
        add_member_message: params.message,
        misc_message: params.misc_message,

        readability: world.readability,
        writability: world.writability,

        go_to_coord: world.feature_go_to_coord,
        coord_link: world.feature_coord_link,
        url_link: world.feature_url_link,
        paste: world.feature_paste,
        membertiles_addremove: world.feature_membertiles_addremove,
        chat_permission: properties.chat_permission || 0,
        color_text: properties.color_text || 0,

        color,
        cursor_color,
        cursor_guest_color,
        bg,
        owner_color,
        member_color,
        menu_color,

        owner_name,
        page_is_nsfw: !!properties.page_is_nsfw,
        square_chars: !!properties.square_chars,
        no_log_edits: !!properties.no_log_edits,
        half_chars:   !!properties.half_chars,

        background_path: properties.background ? properties.background : "",
        meta_desc: properties.meta_desc
    };

    serve(HTML("configure.html", data));
}

module.exports.POST = async function(req, serve, vars) {
    var db = vars.db;
    var post_data = vars.post_data;
    var user = vars.user;
    var get_third = vars.get_third;
    var path = vars.path;
    var dispage = vars.dispage;
    var url = vars.url;
    var world_get_or_create = vars.world_get_or_create;
    var ws_broadcast = vars.ws_broadcast;
    var validate_claim_worldname = vars.validate_claim_worldname;
    var transaction = vars.transaction;
    var advancedSplit = vars.advancedSplit;
    var decodeCharProt = vars.decodeCharProt;
    var encodeCharProt = vars.encodeCharProt;
    var clearChatlog = vars.clearChatlog;
    var tile_database = vars.tile_database;

    if(!user.authenticated) {
        return serve();
    }

    var world_name = get_third(path, "accounts", "configure");

    var world = await world_get_or_create(world_name);
    if(!world) {
        return await dispage("404", null, req, serve, vars);
    }

    world_name = world.name;

    if(world.owner_id != user.id && !user.superuser) {
        return serve("Access denied", 403);
    }

    var properties = JSON.parse(world.properties);
    var new_world_name = null;

    if(post_data.form == "add_member") {
        var username = post_data.add_member;
        var date = Date.now();
        var adduser = await db.get("SELECT * from auth_user WHERE username=? COLLATE NOCASE", username);
        if(!adduser) {
            return await dispage("configure", { message: "User not found" }, req, serve, vars);
        }
        if(adduser.id == world.owner_id) {
            return await dispage("configure", {
                message: "User is already the owner of \"" + world_name + "\""
            }, req, serve, vars);
        }
        var whitelist = await db.get("SELECT * FROM whitelist WHERE user_id=? AND world_id=?",
            [adduser.id, world.id]);
        if(whitelist) {
            return await dispage("configure", {
                message: "User is already part of this world"
            }, req, serve, vars);
        }

        await db.run("INSERT into whitelist VALUES(null, (SELECT id FROM auth_user WHERE username=? COLLATE NOCASE), ?, ?)", [username, world.id, date]);

        return await dispage("configure", {
            message: adduser.username + " is now a member of the \"" + world_name + "\" world"
        }, req, serve, vars);
    } else if(post_data.form == "access_perm") { // access_perm
        var readability = validatePerms(post_data.readability, 2);
        var writability = validatePerms(post_data.writability, 2);

        await db.run("UPDATE world SET (readability,writability)=(?,?) WHERE id=?",
            [readability, writability, world.id]);
    } else if(post_data.form == "remove_member") {
        var to_remove;
        for(var key in post_data) {
            if(key.startsWith("remove_")) to_remove = key;
        }
        var username_to_remove = to_remove.substr("remove_".length);
        await db.run("DELETE FROM whitelist WHERE user_id=(SELECT id FROM auth_user WHERE username=? COLLATE NOCASE) AND world_id=?", [username_to_remove, world.id]);
    } else if(post_data.form == "features") {
        var go_to_coord = validatePerms(post_data.go_to_coord, 2);
        var coord_link = validatePerms(post_data.coord_link, 2);
        var url_link = validatePerms(post_data.url_link, 2);
        var paste = validatePerms(post_data.paste, 2);
        var chat = validatePerms(post_data.chat, 2, true);
        var color_text = validatePerms(post_data.color_text, 2);
        var membertiles_addremove = post_data.membertiles_addremove;
        if(membertiles_addremove == "false") {
            membertiles_addremove = 0;
        } else if(membertiles_addremove == "true") {
            membertiles_addremove = 1;
        } else {
            membertiles_addremove = 0;
        }
        properties.chat_permission = chat;
        properties.color_text = color_text;

        await db.run("UPDATE world SET (feature_go_to_coord,feature_membertiles_addremove,feature_paste,feature_coord_link,feature_url_link,properties)=(?,?,?,?,?,?) WHERE id=?",
            [go_to_coord, membertiles_addremove, paste, coord_link, url_link, JSON.stringify(properties), world.id]);
    } else if(post_data.form == "style") {
        var color = validateCSS(post_data.color);
        var cursor_color = validateCSS(post_data.cursor_color);
        var cursor_guest_color = validateCSS(post_data.cursor_guest_color);
        var bg = validateCSS(post_data.bg);
        var owner_color = validateCSS(post_data.owner_color);
        var member_color = validateCSS(post_data.member_color);
        var menu_color = validateCSS(post_data.menu_color);
        properties.custom_menu_color = menu_color;

        await db.run("UPDATE world SET (custom_bg,custom_cursor,custom_guest_cursor,custom_color,custom_tile_owner,custom_tile_member,properties)=(?,?,?,?,?,?,?) WHERE id=?",
            [bg, cursor_color, cursor_guest_color, color, owner_color, member_color, JSON.stringify(properties), world.id]);
        
        ws_broadcast({
            kind: "colors",
            colors: {
                cursor: cursor_color || "#ff0",
                text: color || "#000",
                member_area: member_color || "#eee",
                background: bg || "#fff",
                owner_area: owner_color || "#ddd",
                menu: menu_color || "#e5e5ff"
            }
        }, world.name);
    } else if(post_data.form == "misc") {
        var properties_updated = false;
        if(!post_data.world_background && user.superuser) {
            properties_updated = true;
            delete properties.background;
        }
        if(!("nsfw_page" in post_data)) {
            properties_updated = true;
            delete properties.page_is_nsfw;
        }
        if(!("square_chars" in post_data)) {
            properties_updated = true;
            delete properties.square_chars;
        }
        if(!("no_log_edits" in post_data)) {
            properties_updated = true;
            delete properties.no_log_edits;
        }
        if(!("half_chars" in post_data)) {
            properties_updated = true;
            delete properties.half_chars;
        }
        if(!post_data.meta_desc) {
            properties_updated = true;
            delete properties.meta_desc;
        }
        var new_name = post_data.new_world_name + "";
        if(new_name && new_name != world.name) { // changing world name
            var validate = await validate_claim_worldname(new_name, vars, true, world.id);
            if(validate.error) { // error with renaming
                return await dispage("configure", {
                    misc_message: validate.message
                }, req, serve, vars);
            }
            if(validate.rename) {
                await db.run("UPDATE world SET name=? WHERE id=?", [validate.new_name, world.id]);
                new_world_name = validate.new_name;
            }
        }
        if(post_data.world_background && user.superuser) {
            properties.background = post_data.world_background;
            properties_updated = true;
        }
        if("nsfw_page" in post_data) {
            properties.page_is_nsfw = true;
            properties_updated = true;
        }
        if("square_chars" in post_data) {
            properties.square_chars = true;
            properties_updated = true;
        }
        if("no_log_edits" in post_data) {
            properties.no_log_edits = true;
            properties_updated = true;
        }
        if("half_chars" in post_data) {
            properties.half_chars = true;
            properties_updated = true;
        }
        if(post_data.meta_desc) {
            var mdesc = post_data.meta_desc;
            if(typeof mdesc != "string") mdesc = "";
            mdesc = mdesc.trim();
            mdesc = mdesc.slice(0, 600);
            mdesc = mdesc.replace(/\r\n/g, "\n");
            mdesc = mdesc.replace(/\n/g, " ");
            if(!mdesc) {
                delete properties.meta_desc;
            } else {
                properties.meta_desc = mdesc;
            }
            properties_updated = true;
        }

        if(properties_updated) {
            await db.run("UPDATE world SET properties=? WHERE id=?",
                [JSON.stringify(properties), world.id]);
        }
    } else if(post_data.form == "action") {
        if("unclaim" in post_data) {
            await db.run("UPDATE world SET owner_id=null WHERE id=?", world.id);
            return serve(null, null, {
                redirect: "/accounts/profile/"
            });
        } else if("clear_public" in post_data) {
            var tileCount = await db.get("SELECT count(id) AS cnt FROM tile WHERE world_id=?", world.id);
            if(!tileCount) return;
            tileCount = tileCount.cnt;
            // tile limit of 30000
            if(tileCount <= 30000) {
                tile_database.write(null, tile_database.types.publicclear, {
                    date: Date.now(),
                    world,
                    user
                });
            }
        } else if("clear_all" in post_data) {
            // small command, big impact
            await db.run("DELETE FROM tile WHERE world_id=?", world.id);
            await db.run("INSERT INTO edit VALUES(null, ?, ?, ?, ?, ?, ?)",
                [user.id, world.id, 0, 0, Date.now(), "@{\"kind\":\"clear_all\"}"]);
        } else if("clear_chat_hist" in post_data) {
            clearChatlog(world.id);
        }
    }

    if(new_world_name == null) {
        serve(null, null, {
            redirect: url.parse(req.url).pathname
        });
    } else { // world name changed, redirect to new name
        serve(null, null, {
            redirect: "/accounts/configure/" + new_world_name + "/"
        });
    }
}