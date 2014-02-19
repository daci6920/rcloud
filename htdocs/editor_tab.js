var editor = function () {
    // major key is adsort_order and minor key is name (label)
    var ordering = {
        HEADER: 0, // at top (unused)
        NOTEBOOK: 1,
        SUBFOLDER: 2
    };
    var CONFIG_VERSION = 1;

    /* "Model-Model-View-Controller"
     .. or something ..
     there are two models: the local state and the global rcs+github
     the local model is private data of this class

     E.g. an interest ("star") is reflected in 7 places:
     Global model
     - the star in rcs (logically in github but they don't have the necessary APIs)
     - the count in rcs
     Local model
     - the entry in interests_[]
     - the bit in i_starred_[] (for efficiency)
     View
     - the existence of the node under My Interests in the notebook tree UI
     - the filling of the star icon next to the node under All Notebooks in the tree UI
     - the filling of the star icon in the navbar (if current notebook)
     */

    // local model
    var username_ = null,
        histories_ = {},
        all_entries_ = {}, // all notebooks we are aware of
        num_stars_ = {}, // number of stars for all known notebooks
        i_starred_ = {},
        interests_ = null,
        current_ = null;

    // view
    var $tree_ = undefined,
        publish_notebook_checkbox_ = null,
        star_notebook_button_ = null;

    //  Model functions

    // find a migration path from one version to another,
    // do a depth-first search then apply all the migration functions.
    // obviously results will be unpredictable if there is more than one path.
    function migrate_config() {
        // do server-side
        return true;
    }

    function get_notebook_status(user, gistname) {
        var iu = interests_[user];
        return (iu && iu[gistname]) || all_entries_[gistname] || {};
    }

    function add_interest(user, gistname, entry) {
        var iu = interests_[user];
        if(!iu)
            iu = interests_[user] = {};
        iu[gistname] = entry;

        i_starred_[gistname] = true;
    }

    function remove_interest(user, gistname) {
        delete interests_[user][gistname];
        delete i_starred_[gistname];
        if(user!==username_ && _.isEmpty(interests_[user]))
            delete interests_[user];
    }

    function add_all(user, gistname, entry) {
        all_entries_[gistname] = entry;
        return user === username_ ?
            rcloud.config.add_notebook(gistname, entry) :
            Promise.resolve();
    }

    function remove_all(user, gistname) {
        return user === username_ ?
            rcloud.config.remove_notebook(gistname) :
            Promise.resolve();
    }

    function update_notebook_model(user, gistname, description, time) {
        var entry = get_notebook_status(user, gistname);

        entry.description = description;
        entry.last_commit = time;
        entry.visibility = entry.visibility || 'public';

        if(i_starred_[gistname])
            add_interest(user, gistname, entry);
        add_all(user, gistname, entry);
        return entry; // note: let go of promise
    }


    // View (tree) functions

    function node_id(root, username, gistname, version) {
        var ret = '';
        for(var i=0; i < arguments.length; ++i)
            ret = ret + '/' + arguments[i];
        return ret;
    }

    function compare_nodes(a, b) {
        var so = a.sort_order-b.sort_order;
        if(so) return so;
        else {
            var alab = a.name || a.label, blab = b.name || b.label;
            // haha horrible special case to sort "Notebook X" numerically!
            if(/Notebook /.test(alab) && /Notebook /.test(blab)) {
                var an = alab.slice(9), bn = blab.slice(9);
                if($.isNumeric(an) && $.isNumeric(bn))
                    return an-bn;
            }
            var lc = alab.localeCompare(blab);
            if(lc === 0) // make sort stable on gist id (creation time would be better)
                lc = a.gistname.localeCompare(b.gistname);
            return lc;
        }
    }

    function as_folder_hierarchy(nodes, prefix) {
        function is_in_folder(v) { return v.label.match(/([^/]+)\/(.+)/); }
        var in_folders = nodes;
        in_folders = _.filter(in_folders, is_in_folder);
        in_folders = _.map(in_folders, function(v) {
            var m = v.label.match(/([^/]+)\/(.+)/);
            var r = _.clone(v);
            r.folder_name = m[1];
            r.label = m[2];
            return r;
        });
        in_folders = _.groupBy(in_folders, function(v) {
            return v.folder_name;
        });
        in_folders = _.map(in_folders, function(v, k) {
            var children = _.map(v, function(o) {
                return _.omit(o, "folder_name");
            });
            var id = prefix + '/' + k;
            return {
                label: k,
                sort_order: ordering.NOTEBOOK,
                id: id,
                children: as_folder_hierarchy(children, id)
            };
        });
        var outside_folders = _.filter(nodes, function(v) {
            return !is_in_folder(v);
        });
        return outside_folders.concat(in_folders).sort(compare_nodes);
    }

    function convert_notebook_set(root, username, set) {
        var notebook_nodes = [];
        for(var name in set) {
            var attrs = set[name];
            if(username!==username_ && root==='alls' && attrs.visibility==='private')
                continue;
            var result = {
                label: attrs.description,
                gistname: name,
                user: username,
                root: root,
                visibility: attrs.visibility || 'public',
                last_commit: attrs.last_commit || 'none',
                id: node_id(root, username, name),
                sort_order: ordering.NOTEBOOK
            };
            notebook_nodes.push(result);
        }
        return notebook_nodes;
    }

    function populate_interests(root_data) {
        function create_user_book_entry_map(books) {
            return _.reduce(books,
                            function(users, book){
                                var entry = all_entries_[book];
                                if(!entry) {
                                    console.log("rcloud.stars.get_my_starred_notebooks reports a notebook starred that is not listed in All Notebooks: " + book);
                                    return users;
                                }
                                var user = users[entry.user] = users[entry.user] || {};
                                user[book] = entry;
                                return users;
                            },
                            {});
        }

        return rcloud.stars.get_my_starred_notebooks()
            .then(function(starred) {
                interests_ = create_user_book_entry_map(starred);
                var my_notebooks, user_nodes = [];
                for (var username in interests_) {
                    var user_notebooks = interests_[username];
                    for(var gistname in user_notebooks) {
                        i_starred_[gistname] = true;
                        // sanitize... this shouldn't really happen...
                        if(!user_notebooks[gistname].description)
                            user_notebooks[gistname].description = "(no description)";
                    }

                    var notebook_nodes = [];
                    notebook_nodes = notebook_nodes.concat(convert_notebook_set('interests', username, user_notebooks));

                    if(username === username_)
                        my_notebooks = notebook_nodes;
                    else {
                        var id = node_id('interests', username);
                        var node = {
                            label: someone_elses(username),
                            id: id,
                            sort_order: ordering.SUBFOLDER,
                            children: as_folder_hierarchy(notebook_nodes, id).sort(compare_nodes)
                        };
                        user_nodes.push(node);
                    }
                }
                var children = as_folder_hierarchy(my_notebooks, node_id('interests', username_));
                children = children.concat(user_nodes).sort(compare_nodes);
                root_data[0].children = children;
                return root_data;
            });
    }

    function load_tree(root_data) {
        // delay construction of dom elements for Alls
        var alls = root_data[1].children;
        for(var i = 0; i < alls.length; ++i)
            if(alls[i].children && alls[i].children.length) {
                alls[i].delay_children = alls[i].children;
                alls[i].children = [{label: 'loading...'}];
            }
        result.create_book_tree_widget(root_data);
        var interests = $tree_.tree('getNodeById', "/interests");
        $tree_.tree('openNode', interests);
    }

    function load_notebook_list(user_notebooks, notebook_entries) {
        function create_book_entry_map(books) {
            return _.reduce(books,
                            function(map, book) {
                                var entry = all_entries_[book];
                                if(!entry)
                                    throw new Error("didn't find notebook " + book + " in alls");
                                map[book] = entry;
                                return map;
                            },
                            {});
        }

        all_entries_ = notebook_entries;

        var my_alls = [], user_nodes = [], my_config = null;
        for(var username in user_notebooks) {
            var notebook_nodes =
                    convert_notebook_set('alls', username,
                                         create_book_entry_map(user_notebooks[username]));
            if(username === username_)
                my_alls = notebook_nodes;
            else {
                var id = node_id('alls', username);
                var node = {
                    label: someone_elses(username),
                    id: id,
                    sort_order: ordering.SUBFOLDER,
                    children: as_folder_hierarchy(notebook_nodes, id).sort(compare_nodes)
                };
                user_nodes.push(node);
            }
        }

        // start creating the tree data and pass it forward
        // populate_interests will create the tree
        var children = as_folder_hierarchy(my_alls, node_id('alls', username_));
        children = children.concat(user_nodes).sort(compare_nodes);
        var root_data = [
            {
                label: 'My Interests',
                id: '/interests'
            },
            {
                label: 'All Notebooks',
                id: '/alls',
                children: children
            }
        ];
        return root_data;
    }

    function load_everything() {
        return rcloud.config.get_all_notebooks()
            .spread(load_notebook_list)
            .then(function(root_data) {
                return rcloud.config.get_current_notebook()
                    .then(function(current) {
                        current_ = current;
                    })
                    .return(_.keys(all_entries_))
                    .then(rcloud.stars.get_multiple_notebook_star_counts)
                    .then(function(counts) { num_stars_ = counts; })
                    .return(root_data);
            })
            .then(populate_interests)
            .then(load_tree);
    }

    function insert_alpha(data, parent) {
        // this could be a binary search but linear is probably fast enough
        // for a single insert, and it also could be out of order
        for(var i = 0; i < parent.children.length; ++i) {
            var child = parent.children[i];
            var so = compare_nodes(data, child);
            if(so<0)
                return $tree_.tree('addNodeBefore', data, child);
        }
        return $tree_.tree('appendNode', data, parent);
    }

    function remove_empty_parents(dp) {
        // remove any empty notebook hierarchy
        while(dp.children.length===0 && dp.sort_order===ordering.NOTEBOOK) {
            var dp2 = dp.parent;
            $tree_.tree('removeNode', dp);
            dp = dp2;
        }
    }

    function update_tree(root, user, gistname, path, last_chance, create) {
        // make sure parents exist
        var id = user===username_ ? node_id(root) : node_id(root, user),
            parent = $tree_.tree('getNodeById', id),
            pdat = null,
            node = null;
        if(!parent) {
            if(user===username_)
                throw "my folder should be there at least";
            parent = $tree_.tree('getNodeById', node_id(root));
            if(!parent)
                throw "root '" + root + "' of notebook tree not found!";
            pdat = {
                label: someone_elses(user),
                id: node_id(root, user),
                sort_order: ordering.SUBFOLDER
            };
            parent = insert_alpha(pdat, parent);
        }
        while('children' in path) {
            node = $tree_.tree('getNodeById', path.id);
            if(!node) {
                pdat = _.omit(path, 'children');
                node = insert_alpha(pdat, parent);
            }
            parent = node;
            path = path.children[0];
        }
        var data = path;
        id = node_id(root, user, gistname);
        node = $tree_.tree('getNodeById', id);
        if(!node && !create)
            return null;
        var children;
        data.gistname = gistname;
        data.id = id;
        data.root = root;
        data.user = user;
        if(node) {
            children = node.children;
            if(last_chance)
                last_chance(node); // hacky
            var dp = node.parent;
            if(dp===parent && node.name===data.label)
                $tree_.tree('updateNode', node, data);
            else {
                $tree_.tree('removeNode', node);
                node = insert_alpha(data, parent);
                remove_empty_parents(dp);
            }
        }
        else
            node = insert_alpha(data, parent);
        return node;
    }

    function find_index(collection, filter) {
        for (var i = 0; i < collection.length; i++) {
            if(filter(collection[i], i, collection))
                return i;
        }
        return -1;
    }


    // add_history_nodes
    // whither is 'hide' - erase all, 'index' - show thru index, 'sha' - show thru sha, 'more' - show INCR more
    function add_history_nodes(node, whither, where) {
        const INCR = 5;
        var debug_colors = false;
        var ellipsis = null;
        if(node.children.length && node.children[node.children.length-1].id == 'showmore')
            ellipsis = node.children[node.children.length-1];
        function curr_count() {
            var n = node.children.length;
            return ellipsis ? n-1 : n;
        }
        function show_sha(history, sha) {
            var sha_ind = find_index(history, function(hist) { return hist.version===sha; });
            if(sha_ind<0)
                throw "didn't find sha " + where + " in history";
            return sha_ind + INCR - 1; // show this many including curr (?)
        }

        function process_history(nshow) {
            function do_color(dat, color) {
                if(debug_colors)
                    dat.color = color;
            }
            function add_hist_node(hist, insf, color) {
                var hdat = _.clone(node);
                var sha = hist.version.substring(0, 10);
                hdat.label = sha;
                hdat.version = hist.version;
                hdat.last_commit = hist.committed_at;
                hdat.id = node.id + '/' + hdat.version;
                do_color(hdat, color);
                var nn = insf(hdat);
            }
            var history = histories_[node.gistname].slice(1); // first item is current version
            if(!history)
                return;
            var children = [];
            nshow = Math.min(nshow, history.length);

            if(debug_colors)
                for(var ii = 0, ee = curr_count(); ii<ee; ++ii)
                    $tree_.tree('updateNode', node.children[ii], {color: ''});

            // insert at top
            var nins, insf = null;
            if(node.children.length) {
                var first = node.children[0];
                nins = find_index(history, function(h) { return h.version==first.version; });
                insf = function(dat) { return $tree_.tree('addNodeBefore', dat, first); };
            }
            else {
                nins = nshow;
                insf = function(dat) { return $tree_.tree('appendNode', dat, node); };
            }
            for(var i=0; i<nins; ++i)
                add_hist_node(history[i], insf, 'green');

            var count = curr_count();
            if(count < nshow) { // top up
                if(ellipsis)
                    insf = function(dat) { return $tree_.tree('addNodeBefore', dat, ellipsis); };
                else
                    insf = function(dat) { return $tree_.tree('appendNode', dat, node); };
                for(i=count; i<nshow; ++i)
                    add_hist_node(history[i], insf, 'mediumpurple');
            }
            else if(count > nshow) // trim any excess
                for(i=count-1; i>=nshow; --i)
                    $tree_.tree('removeNode', node.children[i]);

            // hide or show ellipsis
            if(ellipsis) {
                if(nshow === history.length)
                    $tree_.tree('removeNode', ellipsis);
            }
            else {
                if(nshow < history.length) {
                    var data = {
                        label: '...',
                        id: 'showmore'
                    };
                    $tree_.tree('appendNode', data, node);
                }
            }
        }
        var nshow = undefined;
        if(whither==='hide') {
            for(var i = node.children.length-1; i >= 0; --i)
                $tree_.tree('removeNode', node.children[i]);
            return Promise.resolve(node);
        }
        else if(whither==='index')
            nshow = Math.max(where, INCR);
        else if(whither==='more')
            nshow = curr_count() + INCR;
        else if(whither==='sha') {
            if(histories_[node.gistname])
                nshow = show_sha(histories_[node.gistname], where);
        }
        else throw "add_history_nodes don't understand how to seek '" + whither + "'";

        if(histories_[node.gistname]) {
            process_history(nshow);
            return Promise.resolve(node);
        }
        else
            return rcloud.load_notebook(node.gistname, null).then(function(notebook) {
                histories_[node.gistname] = notebook.history;
                if(whither==='sha')
                    nshow = show_sha(histories_[node.gistname], where);
                process_history(nshow);
                return node;
            });
    }

    function scroll_into_view(node) {
        var height = $tree_.parent().css("height").replace("px","");
        var p = node.parent;
        while(p.sort_order===ordering.NOTEBOOK) {
            $tree_.tree('openNode', p);
            p = p.parent;
        }
        if($(node.element).position().top > height)
            $tree_.parent().scrollTo(null, $tree_.parent().scrollTop()
                                     + $(node.element).position().top - height + 50);
        else if($(node.element).position().top < 0)
            $tree_.parent().scrollTo(null, $tree_.parent().scrollTop()
                                     + $(node.element).position().top - 100);
    }

    var last_editable_ = null;
    function make_title_editable(node_title, gistname, editable) {
        if(last_editable_ && (!node_title || last_editable_[0] !== node_title[0]))
            ui_utils.make_editable(last_editable_, false);
        if(node_title)
            ui_utils.make_editable(node_title,
                                   editable,
                                   function(result) {
                                       if(editor.rename_notebook(gistname, result)) {
                                           shell.set_title(result);
                                           return true;
                                       }
                                       else return false;
                                   });
        last_editable_ = node_title;
    }

    function select_node(node) {
        $tree_.tree('selectNode', node);
        scroll_into_view(node);
        if(!node.version)
            make_title_editable($('.jqtree-title:not(.history)', node.element),
                                node.gistname, !shell.notebook.model.read_only());
        else make_title_editable(null);
    }

    function update_tree_entry(root, user, gistname, entry, create) {
        var data = {label: entry.description,
                    last_commit: entry.last_commit,
                    sort_order: ordering.NOTEBOOK,
                    visibility: entry.visibility};

        // always show the same number of history nodes as before
        var whither = 'hide', where = null;
        var inter_path = as_folder_hierarchy([data], node_id(root, user))[0];
        var node = update_tree(root, user, gistname, inter_path,
                               function(node) {
                                   if(node.children.length) {
                                       whither = 'index';
                                       where = node.children.length;
                                       if(node.children[where-1].id==='showmore')
                                           --where;
                                   }
                               }, create);
        if(!node)
            return Promise.resolve(null); // !create

        // if we're looking at an old version, make sure it's visible
        if(gistname===current_.book && current_.version) {
            whither = 'sha';
            where = current_.version;
        }
        var promise = add_history_nodes(node, whither, where);
        if(current_.version)
            promise = promise.then(function(node) {
                $tree_.tree('openNode', node);
                var n2 = $tree_.tree('getNodeById',
                                     node_id(root, user, gistname, current_.version));
                if(!n2)
                    throw 'tree node was not created for current history';
                return n2;
            });
        return promise;
    }

    function update_notebook_view(user, gistname, entry, selroot) {
        var p;
        if(selroot === true)
            selroot = i_starred_[gistname] ? 'interests' : 'alls';
        if(i_starred_[gistname]) {
            p = update_tree_entry('interests', user, gistname, entry, true);
            if(selroot==='interests')
                p.then(select_node);
        }
        if(gistname === current_.book) {
            star_notebook_button_.set_state(i_starred_[gistname]);
            $('#curr-star-count').text(num_stars_[gistname] || 0);
        }

        p = update_tree_entry('alls', user, gistname, entry, true);
        if(selroot==='alls')
            p.then(select_node);
    }

    // hack to fake a hover over a node (or the next one if it's deleted)
    // because jqTree rebuilds DOM elements and events get lost
    function fake_hover(node) {
        var parent = node.parent;
        var index = $('.notebook-commands.appear', node.element).css('display') !== 'none' ?
                parent.children.indexOf(node) : undefined;
        setTimeout(function() {
            if(index>=0 && index < parent.children.length) {
                var next = parent.children[index];
                $(next.element).mouseover();
            }
        }, 0);
    }

    function remove_node(node) {
        var parent = node.parent;
        fake_hover(node);
        $tree_.tree('removeNode', node);
        remove_empty_parents(parent);
        if(node.root === 'interests' && node.user !== username_ && parent.children.length === 0)
            $tree_.tree('removeNode', parent);
    }

    function unstar_notebook_view(user, gistname, select) {
        var inter_id = node_id('interests', user, gistname);
        var node = $tree_.tree('getNodeById', inter_id);
        if(!node) {
            console.log("attempt to unstar notebook we didn't know was starred", inter_id);
            return;
        }
        remove_node(node);
        if(gistname === current_.book) {
            star_notebook_button_.set_state(false);
            $('#curr-star-count').text(num_stars_[gistname] || 0);
        }
        node = $tree_.tree('getNodeById', node_id('alls', user, gistname));
        if(select)
            select_node(node);
        var all_star = $(node.element).find('.fontawesome-button.star');
        all_star[0].set_state(false);
        all_star.find('sub').text(num_stars_[gistname] || 0);
    }

    function update_notebook_from_gist(result, history, selroot) {
        var t = performance.now();
        var user = result.user.login, gistname = result.id;
        // we only receive history here if we're at HEAD, so use that if we get
        // it.  otherwise use the remembered history if any.  otherwise
        // add_history_nodes will do an async call to get the history.
        if(history)
            histories_[gistname] = history;

        var entry = update_notebook_model(user, gistname,
                                          result.description,
                                          result.updated_at || result.history[0].committed_at);

        update_notebook_view(user, gistname, entry, selroot);
        console.log("update_notebook_from_gist took " + (performance.now()-t) + "ms");
    }

    function display_date(ds) {
        function pad(n) { return n<10 ? '0'+n : n; }
        if(ds==='none')
            return '';
        var date = new Date(ds);
        var diff = Date.now() - date;
        if(diff < 24*60*60*1000)
            return date.getHours() + ':' + pad(date.getMinutes());
        else
            return (date.getMonth()+1) + '/' + date.getDate();
    }

    function someone_elses(name) {
        return name + "'s Notebooks";
    }

    function populate_comments(comments) {
        try {
            comments = JSON.parse(comments);
        } catch (e) {
            rclient.post_error("populate comments: " + e.message);
            return;
        }
        d3.select("#comment-count")
            .text(String(comments.length));
        // no update logic, clearing/rebuilding is easier
        d3.select("#comments-container").selectAll("div").remove();
        var comment_div = d3.select("#comments-container")
            .selectAll("div")
            .data(comments)
            .enter()
            .append("div")
            .attr("class", "comment-container");

        comment_div
            .append("div")
            .attr("class", "comment-header")
            .text(function(d) { return d.user.login; });
        comment_div
            .append("div")
            .attr("class", "comment-body")
            .text(function(d) { return d.body; });
    }

    const icon_style = {'line-height': '90%'};
    function on_create_tree_li(node, $li) {
        var element = $li.find('.jqtree-element'),
            title = element.find('.jqtree-title');
        title.css('color', node.color);
        if(node.visibility==='private')
            title.addClass('private');
        if(node.version || node.id === 'showmore')
            title.addClass('history');
        var right = $($.el.span({'class': 'notebook-right'}));
        if(node.last_commit && (!node.version ||
                                display_date(node.last_commit) != display_date(node.parent.last_commit))) {
            right[0].appendChild($.el.span({'id': 'date',
                                            'class': 'notebook-date'},
                                           display_date(node.last_commit)));
        }
        if(node.gistname && !node.version) {
            if($tree_.tree('isNodeSelected', node))
                make_title_editable(title, node.gistname, !shell.notebook.model.read_only());
            var adder = function(target) {
                var count = 0;
                var lst = [];
                function add(items) {
                    lst.push(document.createTextNode(String.fromCharCode(160)));
                    lst.push.apply(lst, arguments);
                    ++count;
                }
                add.width = function() {
                    return count*14;
                };
                add.commit = function() {
                    target.append.apply(target, lst);
                };
                return add;
            };
            // commands for the right column, always shown
            var always = $($.el.span({'class': 'notebook-commands-right'}));
            var add_buttons = adder(always);
            var star_style = _.extend({'font-size': '80%'}, icon_style);
            var states = {true: {'class': 'icon-star', title: 'unstar'},
                          false: {'class': 'icon-star-empty', title: 'star'}};
            var state = i_starred_[node.gistname] || false;
            var star_unstar = ui_utils.fa_button(states[state]['class'],
                                                 function(e) { return states[state].title; },
                                                 'star',
                                                 star_style);
            // sigh, ui_utils.twostate_icon should be a mixin or something
            // ... why does this code exist?
            star_unstar.click(function(e) {
                e.preventDefault();
                e.stopPropagation(); // whatever you do, don't let this event percolate
                var new_state = !state;
                result.star_notebook(new_state, {gistname: node.gistname, user: node.user});
            });
            star_unstar[0].set_state = function(val) {
                state = !!val;
                $(this).find('i').attr('class', states[state].class);
            };
            star_unstar[0].appendChild($.el.sub(String(num_stars_[node.gistname] || 0)));
            add_buttons(star_unstar);

            add_buttons.commit();
            right[0].appendChild(always[0]);

            // commands that appear
            var appear = $($.el.span({'class': 'notebook-commands appear'}));
            add_buttons = adder(appear);
            if(true) { // all notebooks have history - should it always be accessible?
                var disable = current_.book===node.gistname && current_.version;
                var history = ui_utils.fa_button('icon-time', 'history', 'history', icon_style);
                // jqtree recreates large portions of the tree whenever anything changes
                // so far this seems safe but might need revisiting if that improves
                if(disable)
                    history.addClass('button-disabled');
                history.click(function() {
                    fake_hover(node);
                    if(!disable) {
                        result.show_history(node, true);
                    }
                    return false;
                });

                add_buttons(history);
            }
            if(node.user===username_) {
                var make_private = ui_utils.fa_button('icon-eye-close', 'make private', 'private', icon_style),
                    make_public = ui_utils.fa_button('icon-eye-open', 'make public', 'public', icon_style);
                if(node.visibility=='public')
                    make_public.hide();
                else
                    make_private.hide();
                make_private.click(function() {
                    fake_hover(node);
                    result.set_visibility(node, 'private');
                });
                make_public.click(function() {
                    fake_hover(node);
                    result.set_visibility(node, 'public');
                    return false;
                });
                add_buttons(make_private, make_public);
            }
            if(node.user===username_) {
                var remove = ui_utils.fa_button('icon-remove', 'remove', 'remove', icon_style);
                remove.click(function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    result.remove_notebook(node.user, node.gistname);
                    return false;
                });
                add_buttons(remove);
            };
            var wid = add_buttons.width()+'px';
            add_buttons.commit();
            appear.css({left: '-'+wid, width: wid});
            appear.hide();
            always[0].appendChild(appear[0]);
            $li.hover(
                function() {
                    $('.notebook-commands.appear', this).show();
                },
                function() {
                    $('.notebook-commands.appear', this).hide();
                });
        }
        element[0].appendChild(right[0]);
    }

    function make_main_url(notebook, version) {
        var url = window.location.protocol + '//' + window.location.host + '/main.html?notebook=' + notebook;
        if(version)
            url = url + '&version='+version;
        return url;
    }
    function tree_click(event) {
        if(event.node.id === 'showmore')
            result.show_history(event.node.parent, false);
        else if(event.node.gistname) {
            if(event.click_event.metaKey || event.click_event.ctrlKey) {
                var url = make_main_url(event.node.gistname, event.node.version);
                window.open(url, "_blank");
            }
            else {
                // workaround: it's weird that a notebook exists in two trees but only one is selected (#220)
                // and some would like clicking on the active notebook to edit the name (#252)
                // for now, just select
                if(event.node.gistname === current_.book
                   && event.node.version == current_.version) // nulliness ok here
                    select_node(event.node);
                else {
                    // possibly erase query parameters here, but that requires a reload
                    result.load_notebook(event.node.gistname, event.node.version || null, event.node.root);
                }
            }
        }
        return false;
    }
    function tree_open(event) {
        var n = event.node;
        if(n.delay_children) {
            $tree_.tree('loadData', n.delay_children, n);
            delete n.delay_children;
        }
    }

    var result = {
        init: function(gistname, version) {
            var that = this;
            username_ = rcloud.username();
            $("#input-text-source-results-title").css("display", "none");
            $("#input-text-history-results-title").css("display", "none");
            var promise = load_everything().then(function() {
                if(gistname) // notebook specified in url
                    that.load_notebook(gistname, version);
                else if(current_.book)
                    that.load_notebook(current_.book, current_.version);
                else // brand new user
                    that.new_notebook();
            });
            /* Search disabled for Version 0.9
            var old_text = "";
            window.setInterval(function() {
                var new_text = $("#input-text-search").val();
                if (new_text !== old_text) {
                    old_text = new_text;
                    that.search(new_text);
                }
            }, 500);
             */
            $('#new-notebook').click(function() {
                that.new_notebook();
            });
            function publish_success(gistname, un) {
                return function(val) {
                    var verb = (un ? "un" : "") + "publish";
                    if(!val)
                        console.log("Failed to " + verb + " notebook " + gistname);
                };
            }
            publish_notebook_checkbox_ = ui_utils.checkbox_menu_item($("#publish-notebook"),
               function() {
                   rcloud.publish_notebook(current_.book).then(publish_success(current_.book, false));
               },
               function() {
                   rcloud.unpublish_notebook(current_.book).then(publish_success(current_.book, true));
               });
            var snf = result.star_notebook;
            star_notebook_button_ =
                ui_utils.twostate_icon($("#star-notebook"),
                                       snf.bind(this, true), snf.bind(this, false),
                                       'icon-star', 'icon-star-empty');
            return promise;
        },
        create_book_tree_widget: function(data) {
            var that = this;

            $tree_ = $("#editor-book-tree");
            $tree_.tree({
                data: data,
                onCreateLi: on_create_tree_li,
                selectable: true
            });
            $tree_.bind('tree.click', tree_click);
            $tree_.bind('tree.open', tree_open);
        },
        load_notebook: function(gistname, version, selroot, push_history) {
            var that = this;
            selroot = selroot || true;

            return shell.load_notebook(gistname, version)
                .then(this.load_callback({version: version,
                                          selroot: selroot,
                                          push_history: push_history}));
        },
        new_notebook: function() {
            var that = this;
            return rcloud.config.new_notebook_number()
                .then(function(number) { return "Notebook " + number; })
                .then(shell.new_notebook.bind(shell))
                .then(function(notebook) {
                    that.star_notebook(true, {notebook: notebook, make_current: true, version: null});
                });
        },
        rename_notebook: function(gistname, newname) {
            if (result && !/^\s+$/.test(result)) { // not null and not empty or just whitespace
                rcloud.rename_notebook(gistname, newname).then(this.load_callback({is_change: true, selroot: true}));
                return true;
            }
            else return false;
        },
        star_notebook: function(star, opts) {
            var that = this;
            // if opts has user and gistname use those
            // else if opts has notebook, use notebook id & user
            // else use current notebook & user
            opts = opts || {};
            var user = opts.user
                    || opts.notebook&&opts.notebook.user&&opts.notebook.user.login
                    || current_.user;
            var gistname = opts.gistname
                    || opts.notebook&&opts.notebook.id
                    || current_.book;
            // keep selected if was
            if(gistname === current_.book)
                opts.selroot = opts.selroot || true;
            if(star) {
                return rcloud.stars.star_notebook(gistname).then(function(count) {
                    num_stars_[gistname] = count;
                    var entry = get_notebook_status(user, gistname);
                    if(!entry.description && !opts.notebook) {
                        console.log("attempt to star notebook we have no record of",
                                    node_id('interests', user, gistname));
                        throw new Error("attempt to star notebook we have no record of",
                                        node_id('interests', user, gistname));
                    }
                    add_interest(user, gistname, entry);

                    if(opts.notebook) {
                        if(opts.make_current)
                            that.load_callback({version: opts.version,
                                                is_change: opts.is_change || false,
                                                selroot: 'interests'}) (opts.notebook);
                        else
                            update_notebook_from_gist(opts.notebook, opts.notebook.history, opts.selroot);
                    }
                    else {
                        update_notebook_view(user, gistname, entry, opts.selroot);
                    }
                });
            } else {
                return rcloud.stars.unstar_notebook(gistname).then(function(count) {
                    num_stars_[gistname] = count;
                    remove_interest(user, gistname);
                    unstar_notebook_view(user, gistname, opts.selroot);
                });
            }
        },
        remove_notebook: function(user, gistname) {
            var that = this;
            (!i_starred_[gistname] ? Promise.resolve() :
                this.star_notebook(false, {user: user, gistname: gistname}))
                .then(function() {
                    remove_all(user, gistname);
                    remove_node($tree_.tree('getNodeById', node_id('alls', user, gistname)));
                    if(gistname === current_.book)
                        that.new_notebook();
                });
        },
        set_visibility: function(node, visibility) {
            if(node.user !== username_)
                throw "attempt to set visibility on notebook not mine";
            var entry = interests_[username_][node.gistname];
            entry.visibility = visibility;
            rcloud.config.add_notebook(username_, entry);
            update_tree_entry(node.root, username_, node.gistname, entry, false);
        },
        fork_or_revert_notebook: function(is_mine, gistname, version) {
            shell.fork_or_revert_notebook(is_mine, gistname, version)
                .bind(this)
                .then(function(notebook) {
                    if(is_mine)
                        this.load_callback({is_change: true, selroot: true})(notebook);
                    else this.star_notebook(true, {notebook: notebook,
                                                   make_current: true,
                                                   is_change: !!version,
                                                   version: null});
                });
        },
        show_history: function(node, toggle) {
            var whither = 'more';
            if(node.children.length) {
                if(!node.is_open) {
                    $tree_.tree('openNode', node);
                    return;
                }
                if(toggle) whither = 'hide';
            }
            add_history_nodes(node, whither, null)
                .then(function(node) {
                    $tree_.tree('openNode', node);
                });
        },
        load_callback: function(opts) {
            var that = this;
            var options = $.extend(
                {version: null,
                 is_change: false,
                 selroot: null,
                 push_history: true}, opts);
            return function(result) {
                if(!result.description)
                    throw "Invalid notebook (must have description)";

                current_ = {book: result.id, version: options.version, user: result.user.login};
                rcloud.config.set_current_notebook(current_);

                /*
                // disabling inter-notebook navigation for now - concurrency issues
                options.push_history = false;
                if(options.push_history)
                    (window.location.search ?
                     window.history.pushState :
                     window.history.replaceState)
                    .bind(window.history)
                 */
                window.history.replaceState("rcloud.notebook", null, make_main_url(result.id, options.version));

                var history;
                // when loading an old version you get truncated history
                // we don't want that, even if it means an extra fetch
                if(options.version)
                    history = null;
                else
                    history = result.history;
                // there is a bug in old github where if you make a change you only
                // get the old history and not the current
                // this may be the same bug where the latest version doesn't always
                // show in github
                if(options.is_change && shell.is_old_github())
                    history.unshift({version:'blah'});

                (_.has(num_stars_, result.id) ? Promise.resolve(undefined)
                 : rcloud.stars.get_notebook_star_count(result.id).then(function(count) {
                       num_stars_[result.id] = count;
                 })).then(function() {
                     update_notebook_from_gist(result, history, options.selroot);
                     that.update_notebook_file_list(result.files);
                });

                rcloud.get_all_comments(result.id).then(function(data) {
                    populate_comments(data);
                });
                $("#github-notebook-id").text(result.id).click(false);
                rcloud.is_notebook_published(result.id).then(function(p) {
                    publish_notebook_checkbox_.set_state(p);
                    publish_notebook_checkbox_.enable(result.user.login === username_);
                });
            };
        },
        update_notebook_file_list: function(files) {
            // FIXME natural sort!
            var files_out = _(files).pairs().filter(function(v) {
                var k = v[0];
                return !k.match(/\.([rR]|[mM][dD])$/) && k !== "r_type" && k !== "r_attributes";
            });
            if(files_out.length)
                $("#notebook-assets-header").show();
            else
                $("#notebook-assets-header").hide();

            d3.select("#advanced-menu")
                .selectAll("li .notebook-assets")
                .remove();
            var s = d3.select("#advanced-menu")
                .selectAll("li .notebook-assets")
                .data(files_out)
                .enter()
                .append("li")
                .classed("notebook-assets", true)
                .append("a")
                .attr("tabindex", "-1")
                .attr("href", "#");
            s.append("a")
                .text(function(d) { return d[0]; })
                .attr("href", function(d) { return d[1].raw_url; })
                .attr("target", "_blank");

                // .text(function(d, i) { return String(i); });
        },
        post_comment: function(comment) {
            comment = JSON.stringify({"body":comment});
            return rcloud.post_comment(current_.book, comment).then(function(result) {
                if (!result)
                    return null;
                return rcloud.get_all_comments(current_.book).then(function(data) {
                    populate_comments(data);
                    $('#comment-entry-body').val('');
                });
            });
        },
        search: function(search_string) {
            var that = this;
            function split_source_search_lines(line) {
                var r = /:/g;
                var r2 = /\/([^/]+)\/([^/]+)/;
                var result = [];
                while (r.exec(line) !== null) {
                    result.push(r.lastIndex);
                    if (result.length === 2) {
                        var path = line.substring(0, result[0]-1);
                        var t = path.match(r2);
                        return [t[1], t[2],
                                line.substring(result[0], result[1]-1),
                                line.substring(result[1])];
                    }
                }
                throw "shouldn't get here";
            };
            function split_history_search_lines(line) {
                var t = line.indexOf(':');
                var r = /\|/g;
                var line_number = line.substring(0, t);
                line = line.substring(t+1);
                var result = [];
                while (r.exec(line) !== null) {
                    result.push(r.lastIndex);
                    if (result.length === 2) {
                        return [line_number,
                                line.substring(0, result[0]-1),
                                line.substring(result[0], result[1]-1),
                                line.substring(result[1])];
                    }
                }
                throw "shouldn't get here";
            };

            function update_source_search(result) {
                d3.select("#input-text-source-results-title")
                    .style("display", (result !== null && result.length >= 1)?null:"none");
                var data = _.map(result, split_source_search_lines);
                d3.select("#input-text-source-results-table")
                    .selectAll("tr").remove();
                var td_classes = ["user", "filename", "linenumber", "loc"];
                d3.select("#input-text-source-results-table")
                    .selectAll("tr")
                    .data(data)
                    .enter().append("tr")
                    .selectAll("td")
                    .data(function(d,i) {
                        return _.map(d, function(v, k) {
                            return [v, i];
                        });
                    })
                    .enter()
                    .append("td")
                    .text(function(d, i) {
                        if (i === 2) {
                            return d[0] + ":";
                        } else {
                            return d[0];
                        }
                    })
                    .attr("class", function(d, i) {
                        var j = d[1];
                        d = d[0];
                        if (j === 0 || data[j-1][i] !== d)
                            return "text-result-table-" + td_classes[i];
                        else
                            return "text-result-table-same-" + td_classes[i];
                    })
                    .on("click", function(d, i) {
                        if (i !== 1 && i !== 3)
                            return;
                        var j = d[1];
                        var user = data[j][0], notebook = data[j][1];
                        that.load_notebook(notebook, null);
                    })
                ;
            };
            function update_history_search(result) {
                d3.select("#input-text-history-results-title")
                    .style("display", (result !== null && result.length >= 1)?null:"none");
                var data = _.map(result, split_history_search_lines);
                d3.select("#input-text-history-results-table")
                    .selectAll("tr").remove();
                var td_classes = ["date", "user", "loc"];
                d3.select("#input-text-history-results-table")
                    .selectAll("tr")
                    .data(data)
                    .enter().append("tr")
                    .selectAll("td")
                    .data(function(d,i) {
                        return _.map(d.slice(1), function(v, k) {
                            return [v, i];
                        });
                    })
                    .enter()
                    .append("td")
                    .text(function(d) {
                        return d[0];
                    })
                    .attr("class", function(d, i) {
                        var j = d[1];
                        d = d[0];
                        if (j === 0 || data[j-1][i+1] !== d)
                            return "text-result-table-" + td_classes[i];
                        else
                            return "text-result-table-same-" + td_classes[i];
                    })
                    .on("click", function(d, i) {
                    })
                ;
            };
            rcloud.search(search_string).then(function(result) {
                update_source_search(result[0]);
                update_history_search(result[1]);
            });
        }
    };
    return result;
}();
